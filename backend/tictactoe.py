"""Server-authoritative two-player Tic-Tac-Toe matches."""
import json
from datetime import datetime
from flask import Blueprint, g, jsonify, request
from sqlalchemy import or_
from auth import login_required
from database import db
from models import Friendship, User
from profiles import avatar_url

tictactoe_bp = Blueprint('tictactoe', __name__)

class TicTacToeMatch(db.Model):
    __tablename__ = 'tictactoe_match'
    id = db.Column(db.Integer, primary_key=True)
    player_x_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False, index=True)
    player_o_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=True, index=True)
    status = db.Column(db.String(16), nullable=False, default='pending', index=True)
    board_json = db.Column(db.Text, nullable=False, default='[null,null,null,null,null,null,null,null,null]')
    turn = db.Column(db.String(1), nullable=False, default='X')
    winner_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)


def _payload(m, uid):
    x, o = db.session.get(User, m.player_x_id), db.session.get(User, m.player_o_id) if m.player_o_id else None
    you = 'X' if uid == m.player_x_id else 'O'
    return {'id':m.id,'status':m.status,'board':json.loads(m.board_json),'turn':m.turn,'you':you,
            'your_turn':m.status == 'active' and m.turn == you,'winner':m.winner_id,
            'players':{'X':{'id':x.id,'name':x.full_name},'O':({'id':o.id,'name':o.full_name} if o else None)},
            'result': ('draw' if m.status=='draw' else ('win' if m.winner_id==uid else 'loss')) if m.status in ('won','draw') else None}

def _friend_ids(uid):
    rows = Friendship.query.filter(or_(Friendship.user_low_id==uid, Friendship.user_high_id==uid)).all()
    return [r.user_high_id if r.user_low_id==uid else r.user_low_id for r in rows]

@tictactoe_bp.get('/tictactoe/friends')
@login_required
def friends():
    out=[]
    for uid in _friend_ids(g.me_id):
        u=db.session.get(User,uid)
        if u: out.append({'id':u.id,'name':u.full_name,'username':u.username,'avatar_url':avatar_url(u.id)})
    return jsonify(out)

@tictactoe_bp.post('/tictactoe/invites')
@login_required
def invite():
    target=(request.get_json(silent=True) or {}).get('user_id')
    try: target=int(target)
    except (TypeError,ValueError): return jsonify(message='Choose a valid friend.'),400
    if target not in _friend_ids(g.me_id): return jsonify(message='You can only challenge an accepted friend.'),403
    active=TicTacToeMatch.query.filter(TicTacToeMatch.status.in_(('pending','active')),or_(TicTacToeMatch.player_x_id==g.me_id,TicTacToeMatch.player_o_id==g.me_id)).first()
    if active: return jsonify(message='Finish your current Tic-Tac-Toe match first.'),409
    pending=TicTacToeMatch.query.filter_by(player_x_id=g.me_id,player_o_id=target,status='pending').first()
    if pending: return jsonify(id=pending.id,message='Invitation is already waiting.'),200
    m=TicTacToeMatch(player_x_id=g.me_id,player_o_id=target,status='pending')
    db.session.add(m);db.session.commit()
    return jsonify(id=m.id,message='Invitation sent.'),201

@tictactoe_bp.get('/tictactoe/invites')
@login_required
def invites():
    rows=TicTacToeMatch.query.filter(TicTacToeMatch.status.in_(('pending','active')),or_(TicTacToeMatch.player_x_id==g.me_id,TicTacToeMatch.player_o_id==g.me_id)).order_by(TicTacToeMatch.created_at.desc()).limit(30).all()
    result=[]
    for m in rows:
        sender=db.session.get(User,m.player_x_id)
        result.append({'id':m.id,'direction':'outgoing' if m.player_x_id==g.me_id else 'incoming','sender':sender.full_name if sender else 'Friend','status':m.status})
    return jsonify(result)

@tictactoe_bp.post('/tictactoe/matches/<int:mid>/accept')
@login_required
def accept(mid):
    m=db.session.get(TicTacToeMatch,mid)
    if not m or m.player_o_id!=g.me_id or m.status!='pending': return jsonify(message='This invitation is no longer available.'),404
    m.status='active';m.updated_at=datetime.utcnow();db.session.commit()
    return jsonify(_payload(m,g.me_id))

@tictactoe_bp.get('/tictactoe/matches/<int:mid>')
@login_required
def get_match(mid):
    m=db.session.get(TicTacToeMatch,mid)
    if not m or g.me_id not in (m.player_x_id,m.player_o_id): return jsonify(message='Match not found.'),404
    return jsonify(_payload(m,g.me_id))

@tictactoe_bp.post('/tictactoe/matches/<int:mid>/move')
@login_required
def move(mid):
    m=db.session.get(TicTacToeMatch,mid)
    if not m or g.me_id not in (m.player_x_id,m.player_o_id): return jsonify(message='Match not found.'),404
    if m.status!='active': return jsonify(message='This match is not active.'),409
    mark='X' if g.me_id==m.player_x_id else 'O'
    if m.turn!=mark: return jsonify(message='It is not your turn.'),409
    data=request.get_json(silent=True) or {}
    try: cell=int(data.get('cell'))
    except (TypeError,ValueError): return jsonify(message='Choose a square.'),400
    if cell<0 or cell>8: return jsonify(message='That square is outside the board.'),400
    board=json.loads(m.board_json)
    if board[cell] is not None: return jsonify(message='That square is already taken.'),409
    board[cell]=mark
    wins=((0,1,2),(3,4,5),(6,7,8),(0,3,6),(1,4,7),(2,5,8),(0,4,8),(2,4,6))
    winning=any(all(board[i]==mark for i in line) for line in wins)
    m.board_json=json.dumps(board)
    if winning: m.status='won';m.winner_id=g.me_id
    elif all(board): m.status='draw'
    else: m.turn='O' if mark=='X' else 'X'
    m.updated_at=datetime.utcnow();db.session.commit()
    return jsonify(_payload(m,g.me_id))

@tictactoe_bp.post('/tictactoe/matches/<int:mid>/decline')
@login_required
def decline(mid):
    m=db.session.get(TicTacToeMatch,mid)
    if not m or g.me_id not in (m.player_x_id,m.player_o_id) or m.status!='pending': return jsonify(message='Invitation not found.'),404
    m.status='declined';db.session.commit();return jsonify(ok=True)

@tictactoe_bp.post('/tictactoe/matches/<int:mid>/resign')
@login_required
def resign(mid):
    m=db.session.get(TicTacToeMatch,mid)
    if not m or g.me_id not in (m.player_x_id,m.player_o_id) or m.status!='active': return jsonify(message='Active match not found.'),404
    m.status='won';m.winner_id=m.player_o_id if g.me_id==m.player_x_id else m.player_x_id;db.session.commit()
    return jsonify(_payload(m,g.me_id))
