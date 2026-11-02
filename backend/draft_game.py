"""Server-authoritative online draughts for Vynqo.

Modes: English (8x8, 12 pieces) and Nigerian (10x10, 20 pieces).
The server validates every move and owns the board state. Clients poll at a
short interval so the game works without a separate websocket service.
"""
import json, secrets
from datetime import datetime, timedelta
from flask import Blueprint, jsonify, request, g
from sqlalchemy import or_
from auth import login_required
from database import db
from models import User, Friendship, Profile
from profiles import avatar_url

draft_bp = Blueprint('draft_game', __name__)
QUEUES = {}  # ephemeral queue; active matches are persisted below

class DraftMatch(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    code = db.Column(db.String(24), unique=True, nullable=False, index=True)
    mode = db.Column(db.String(16), nullable=False)
    size = db.Column(db.Integer, nullable=False)
    player1_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False, index=True)
    player2_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False, index=True)
    status = db.Column(db.String(16), nullable=False, default='waiting', index=True)
    state_json = db.Column(db.Text, nullable=False)
    turn = db.Column(db.Integer, nullable=False, default=1)
    winner_id = db.Column(db.Integer, nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow)

class DraftInvite(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    code = db.Column(db.String(24), unique=True, nullable=False, index=True)
    mode = db.Column(db.String(16), nullable=False)
    sender_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False, index=True)
    receiver_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False, index=True)
    status = db.Column(db.String(16), nullable=False, default='pending', index=True)
    match_id = db.Column(db.Integer, nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)


def _new_board(size):
    rows = 3 if size == 8 else 4
    board = [[None for _ in range(size)] for _ in range(size)]
    for r in range(rows):
        for c in range(size):
            if (r+c)%2: board[r][c] = 'b'
    for r in range(size-rows, size):
        for c in range(size):
            if (r+c)%2: board[r][c] = 'r'
    return {'board': board, 'selected': None, 'chain': None, 'last_move': None}

def _dirs(piece, mode):
    if piece in ('R','B'): return [(-1,-1),(-1,1),(1,-1),(1,1)]
    forward = -1 if piece == 'r' else 1
    if mode == 'nigerian': return [(-1,-1),(-1,1),(1,-1),(1,1)]
    return [(forward,-1),(forward,1)]

def _inside(r,c,n): return 0 <= r < n and 0 <= c < n

def _captures(board, r, c, mode):
    piece=board[r][c]
    if not piece: return []
    n=len(board); own=piece.lower(); out=[]
    for dr,dc in _dirs(piece,mode):
        if piece in ('R','B') and mode == 'nigerian':
            rr,cc=r+dr,c+dc; enemy=None
            while _inside(rr,cc,n) and board[rr][cc] is None: rr+=dr; cc+=dc
            if _inside(rr,cc,n) and board[rr][cc] and board[rr][cc].lower()!=own:
                enemy=(rr,cc); rr+=dr; cc+=dc
                while _inside(rr,cc,n) and board[rr][cc] is None:
                    out.append({'to':[rr,cc],'take':list(enemy)}); rr+=dr; cc+=dc
        else:
            mr,mc=r+dr,c+dc; tr,tc=r+2*dr,c+2*dc
            if _inside(tr,tc,n) and board[mr][mc] and board[mr][mc].lower()!=own and board[tr][tc] is None:
                out.append({'to':[tr,tc],'take':[mr,mc]})
    return out

def _moves(board, r, c, mode, capture_only=False):
    piece=board[r][c]
    if not piece: return []
    caps=_captures(board,r,c,mode)
    if caps or capture_only: return caps
    n=len(board); out=[]
    for dr,dc in _dirs(piece,mode):
        if piece in ('R','B') and mode == 'nigerian':
            rr,cc=r+dr,c+dc
            while _inside(rr,cc,n) and board[rr][cc] is None:
                out.append({'to':[rr,cc],'take':None}); rr+=dr; cc+=dc
        else:
            rr,cc=r+dr,c+dc
            if _inside(rr,cc,n) and board[rr][cc] is None: out.append({'to':[rr,cc],'take':None})
    return out

def _has_capture(board, side, mode):
    return any(_captures(board,r,c,mode) for r in range(len(board)) for c in range(len(board)) if board[r][c] and board[r][c].lower()==side)

def _legal_for(board, r,c,mode):
    piece=board[r][c]
    if not piece: return []
    return _moves(board,r,c,mode,_has_capture(board,piece.lower(),mode))

def _player_slot(match, uid): return 1 if match.player1_id==uid else 2 if match.player2_id==uid else None

def _users(ids):
    users={u.id:u for u in User.query.filter(User.id.in_(ids)).all()}
    return [{'id':uid,'name':users[uid].full_name,'username':users[uid].username,'avatar_url':avatar_url(uid)} for uid in ids if uid in users]

def _view(m):
    slot=_player_slot(m,g.me_id)
    return {'id':m.id,'code':m.code,'mode':m.mode,'size':m.size,'status':m.status,'you':slot,'turn':m.turn,'your_turn':m.status=='active' and m.turn==slot,'winner':m.winner_id,'players':_users([m.player1_id,m.player2_id]),'state':json.loads(m.state_json),'ready':json.loads(m.state_json).get('ready',[False,False]),'updated_at':m.updated_at.isoformat()+'Z'}

def _start(mode,p1,p2):
    size=8 if mode=='english' else 10
    m=DraftMatch(code=secrets.token_urlsafe(9),mode=mode,size=size,player1_id=p1,player2_id=p2,status='waiting',state_json=json.dumps({**_new_board(size),'ready':[False,False]}),turn=1)
    db.session.add(m); db.session.commit(); return m

def _error(msg,status=400): return jsonify({'message':msg}),status

@draft_bp.get('/draft/friends')
@login_required
def friends():
    me=g.me_id
    rows=Friendship.query.filter(or_(Friendship.user_low_id==me,Friendship.user_high_id==me)).all()
    ids=[x.user_high_id if x.user_low_id==me else x.user_low_id for x in rows]
    users={u.id:u for u in User.query.filter(User.id.in_(ids)).all()} if ids else {}
    now=datetime.utcnow(); seen=dict(Profile.query.with_entities(Profile.user_id,Profile.last_seen).filter(Profile.user_id.in_(ids)).all()) if ids else {}
    busy=set()
    for match in DraftMatch.query.filter(DraftMatch.status=='active', or_(DraftMatch.player1_id.in_(ids), DraftMatch.player2_id.in_(ids))).all():
        busy.update((match.player1_id,match.player2_id))
    return jsonify([{'id':i,'name':users[i].full_name,'username':users[i].username,'online':bool(seen.get(i) and now-seen[i]<timedelta(minutes=3)),'busy':i in busy} for i in ids if i in users])

@draft_bp.post('/draft/invites')
@login_required
def invite():
    data=request.get_json(silent=True) or {}; mode=data.get('mode'); target=data.get('user_id')
    if mode not in ('nigerian','english'): return _error('Choose a valid Draft mode')
    try: target=int(target)
    except (TypeError,ValueError): return _error('Choose a friend to invite')
    low,high=sorted((g.me_id,target))
    if target==g.me_id or not Friendship.query.filter_by(user_low_id=low,user_high_id=high).first(): return _error('You can invite friends only',403)
    if DraftInvite.query.filter_by(sender_id=g.me_id,receiver_id=target,status='pending').first(): return _error('You already invited this friend')
    inv=DraftInvite(code=secrets.token_urlsafe(9),mode=mode,sender_id=g.me_id,receiver_id=target)
    db.session.add(inv); db.session.commit()
    return jsonify({'id':inv.id,'code':inv.code,'status':'pending','sender':g.user.full_name,'mode':mode})

@draft_bp.get('/draft/invites')
@login_required
def incoming():
    rows=DraftInvite.query.filter(or_(DraftInvite.receiver_id==g.me_id, DraftInvite.sender_id==g.me_id)).order_by(DraftInvite.id.desc()).limit(30).all()
    ids={x.sender_id for x in rows}|{x.receiver_id for x in rows}
    users={u.id:u for u in User.query.filter(User.id.in_(ids)).all()} if ids else {}
    return jsonify([{'id':x.id,'mode':x.mode,'status':x.status,'direction':'incoming' if x.receiver_id==g.me_id else 'outgoing','sender':users[x.sender_id].full_name if x.sender_id in users else 'Player','receiver':users[x.receiver_id].full_name if x.receiver_id in users else 'Player','match_id':x.match_id,'created_at':x.created_at.isoformat()+'Z'} for x in rows])

@draft_bp.post('/draft/invites/<int:iid>/accept')
@login_required
def accept(iid):
    inv=DraftInvite.query.filter_by(id=iid,receiver_id=g.me_id,status='pending').first()
    if not inv: return _error('Invitation is no longer available',404)
    inv.status='accepted'; m=_start(inv.mode,inv.sender_id,inv.receiver_id); inv.match_id=m.id; db.session.commit()
    return jsonify(_view(m))


@draft_bp.post('/draft/invites/<int:iid>/decline')
@login_required
def decline_invite(iid):
    inv=DraftInvite.query.filter_by(id=iid,receiver_id=g.me_id,status='pending').first()
    if not inv: return _error('Invitation is no longer available',404)
    inv.status='declined'; db.session.commit()
    return jsonify({'status':'declined'})

@draft_bp.post('/draft/matchmaking')
@login_required
def matchmaking():
    data=request.get_json(silent=True) or {}; mode=data.get('mode')
    if mode not in ('nigerian','english'): return _error('Choose a valid Draft mode')
    # Match the oldest waiting player for this mode; queue entries expire quickly.
    now=datetime.utcnow(); key=(mode,g.me_id)
    for k,v in list(QUEUES.items()):
        if now-v['at']>timedelta(minutes=2): QUEUES.pop(k,None)
    opponent=next(((uid,v) for uid,v in QUEUES.items() if v['mode']==mode and uid!=g.me_id),None)
    if opponent:
        uid,_=opponent; m=_start(mode,uid,g.me_id); QUEUES[uid]={'mode':mode,'at':now,'match_id':m.id}; QUEUES.pop(g.me_id,None); return jsonify({'status':'matched','match':_view(m)})
    QUEUES[g.me_id]={'mode':mode,'at':now}
    return jsonify({'status':'queued','message':'Searching for an opponent'})

@draft_bp.get('/draft/matchmaking')
@login_required
def matchmaking_status():
    item=QUEUES.get(g.me_id)
    if item and item.get('match_id'):
        m=db.session.get(DraftMatch,item['match_id'])
        QUEUES.pop(g.me_id,None)
        if m and _player_slot(m,g.me_id): return jsonify({'status':'matched','match':_view(m)})
    return jsonify({'status':'queued' if item else 'idle'})

@draft_bp.delete('/draft/matchmaking')
@login_required
def cancel_queue():
    QUEUES.pop(g.me_id,None); return jsonify({'status':'cancelled'})

@draft_bp.get('/draft/matches/<int:mid>')
@login_required
def get_match(mid):
    m=db.session.get(DraftMatch,mid)
    if not m or not _player_slot(m,g.me_id): return _error('Match not found',404)
    m.updated_at=datetime.utcnow(); db.session.commit(); return jsonify(_view(m))

@draft_bp.post('/draft/matches/<int:mid>/ready')
@login_required
def ready_match(mid):
    m=db.session.get(DraftMatch,mid)
    if not m or not _player_slot(m,g.me_id): return _error('Match not found',404)
    if m.status not in ('waiting','active'): return _error('This match is no longer waiting')
    state=json.loads(m.state_json); flags=state.setdefault('ready',[False,False]); slot=_player_slot(m,g.me_id)
    flags[slot-1]=True
    if all(flags): m.status='active'
    m.state_json=json.dumps(state); m.updated_at=datetime.utcnow(); db.session.commit()
    return jsonify(_view(m))

@draft_bp.post('/draft/matches/<int:mid>/move')
@login_required
def move(mid):
    m=db.session.get(DraftMatch,mid)
    if not m or not _player_slot(m,g.me_id): return _error('Match not found',404)
    if m.status!='active': return _error('Both players must be ready before the game starts')
    slot=_player_slot(m,g.me_id)
    if slot!=m.turn: return _error('Wait for your turn')
    data=request.get_json(silent=True) or {}; state=json.loads(m.state_json); board=state['board']; mode=m.mode
    try: fr,fc=map(int,data['from']); tr,tc=map(int,data['to'])
    except Exception: return _error('Invalid move')
    if not (_inside(fr,fc,m.size) and _inside(tr,tc,m.size)): return _error('Move is outside the board')
    piece=board[fr][fc]; side='r' if slot==1 else 'b'
    if not piece or piece.lower()!=side: return _error('Select one of your own pieces')
    if state.get('chain') and state['chain'] != [fr,fc]: return _error('Continue the capture with the same piece')
    legal=_legal_for(board,fr,fc,mode)
    chosen=next((x for x in legal if x['to']==[tr,tc]),None)
    if not chosen: return _error('That move is not legal')
    board[fr][fc]=None; board[tr][tc]=piece
    captured=chosen.get('take')
    if captured: board[captured[0]][captured[1]]=None
    # Promotion ends the turn in both modes.
    promoted=(piece=='r' and tr==0) or (piece=='b' and tr==m.size-1)
    if promoted: board[tr][tc]=piece.upper()
    more=bool(captured and not promoted and _captures(board,tr,tc,mode))
    if more: state['chain']=[tr,tc]
    else: state['chain']=None; m.turn=3-slot
    state['last_move']={'from':[fr,fc],'to':[tr,tc],'captured':captured,'by':slot,'at':datetime.utcnow().isoformat()}
    reds=sum(1 for row in board for p in row if p and p.lower()=='r'); blues=sum(1 for row in board for p in row if p and p.lower()=='b')
    next_side='r' if m.turn==1 else 'b'
    if reds==0 or blues==0 or not any(_legal_for(board,r,c,mode) for r in range(m.size) for c in range(m.size) if board[r][c] and board[r][c].lower()==next_side):
        m.status='completed'; m.winner_id=m.player1_id if reds and (not blues or next_side=='b') else m.player2_id
    m.state_json=json.dumps(state); m.updated_at=datetime.utcnow(); db.session.commit()
    return jsonify(_view(m))

@draft_bp.post('/draft/matches/<int:mid>/resign')
@login_required
def resign(mid):
    m=db.session.get(DraftMatch,mid)
    if not m or not _player_slot(m,g.me_id): return _error('Match not found',404)
    if m.status=='active': m.status='completed'; m.winner_id=m.player2_id if m.player1_id==g.me_id else m.player1_id; m.updated_at=datetime.utcnow(); db.session.commit()
    return jsonify(_view(m))
