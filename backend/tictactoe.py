"""Server-authoritative Tic-Tac-Toe with short-lived, real-time friend invitations."""
import json
from datetime import datetime, timedelta
from flask import Blueprint, g, jsonify, request
from sqlalchemy import or_
from auth import login_required
from database import db
from models import Friendship, Profile, User
from profiles import avatar_url

tictactoe_bp = Blueprint("tictactoe", __name__)
socketio = None
INVITE_TTL_SECONDS = 10
ONLINE_WINDOW = timedelta(minutes=3)

class TicTacToeMatch(db.Model):
    __tablename__ = "tictactoe_match"
    id = db.Column(db.Integer, primary_key=True)
    player_x_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False, index=True)
    player_o_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=True, index=True)
    status = db.Column(db.String(16), nullable=False, default="pending", index=True)
    board_json = db.Column(db.Text, nullable=False, default="[null,null,null,null,null,null,null,null,null]")
    turn = db.Column(db.String(1), nullable=False, default="X")
    winner_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)


def init_tictactoe_socket(socket_server):
    global socketio
    socketio = socket_server


def _notify(user_id, event, payload):
    if socketio:
        socketio.emit(event, payload, room=f"vynqo_user_{user_id}")


def _is_online(user_id):
    profile = Profile.query.filter_by(user_id=user_id).first()
    return bool(profile and profile.last_seen and datetime.utcnow() - profile.last_seen < ONLINE_WINDOW)


def _friend_ids(uid):
    rows = Friendship.query.filter(or_(Friendship.user_low_id == uid, Friendship.user_high_id == uid)).all()
    return [row.user_high_id if row.user_low_id == uid else row.user_low_id for row in rows]


def _expire_invite(match):
    if match.status == "pending" and datetime.utcnow() >= match.created_at + timedelta(seconds=INVITE_TTL_SECONDS):
        match.status = "expired"
        match.updated_at = datetime.utcnow()
        db.session.commit()
        _notify(match.player_x_id, "tictactoe_invite_expired", {"match_id": match.id})
        _notify(match.player_o_id, "tictactoe_invite_expired", {"match_id": match.id})
        return True
    return False


def _expire_user_invites(uid):
    rows = TicTacToeMatch.query.filter_by(status="pending").filter(
        or_(TicTacToeMatch.player_x_id == uid, TicTacToeMatch.player_o_id == uid)
    ).all()
    for row in rows:
        _expire_invite(row)


def _payload(match, uid):
    x = db.session.get(User, match.player_x_id)
    o = db.session.get(User, match.player_o_id) if match.player_o_id else None
    you = "X" if uid == match.player_x_id else "O"
    return {"id": match.id, "status": match.status, "board": json.loads(match.board_json), "turn": match.turn,
            "you": you, "your_turn": match.status == "active" and match.turn == you, "winner": match.winner_id,
            "players": {"X": {"id": x.id, "name": x.full_name}, "O": ({"id": o.id, "name": o.full_name} if o else None)},
            "result": ("draw" if match.status == "draw" else ("win" if match.winner_id == uid else "loss")) if match.status in ("won", "draw") else None}


@tictactoe_bp.get("/tictactoe/friends")
@login_required
def friends():
    result = []
    for uid in _friend_ids(g.me_id):
        user = db.session.get(User, uid)
        if not user:
            continue
        profile = Profile.query.filter_by(user_id=uid).first()
        online = _is_online(uid)
        result.append({"id": user.id, "name": user.full_name, "username": user.username,
                       "avatar_url": avatar_url(user.id), "online": online,
                       "last_seen": profile.last_seen.isoformat() + "Z" if profile and profile.last_seen else None})
    result.sort(key=lambda person: (not person["online"], (person["name"] or "").casefold()))
    return jsonify(result)


@tictactoe_bp.post("/tictactoe/invites")
@login_required
def invite():
    data = request.get_json(silent=True) or {}
    try:
        target = int(data.get("user_id"))
    except (TypeError, ValueError):
        return jsonify(message="Choose a valid friend."), 400
    if target == g.me_id or target not in _friend_ids(g.me_id):
        return jsonify(message="You can only challenge an accepted friend."), 403
    _expire_user_invites(g.me_id)
    _expire_user_invites(target)
    active = TicTacToeMatch.query.filter(TicTacToeMatch.status.in_(("pending", "active")),
        or_(TicTacToeMatch.player_x_id == g.me_id, TicTacToeMatch.player_o_id == g.me_id)).first()
    if active:
        return jsonify(message="Finish your current Tic-Tac-Toe match or wait for its invitation to expire."), 409
    match = TicTacToeMatch(player_x_id=g.me_id, player_o_id=target, status="pending")
    db.session.add(match)
    db.session.commit()
    sender = db.session.get(User, g.me_id)
    _notify(target, "tictactoe_invite", {"match_id": match.id, "from_user_id": g.me_id,
        "from_name": sender.full_name if sender else "Your friend", "expires_in": INVITE_TTL_SECONDS, "game": "Tic-Tac-Toe"})
    return jsonify(id=match.id, message="Challenge sent. Your friend has 10 seconds to respond.", expires_in=INVITE_TTL_SECONDS), 201


@tictactoe_bp.get("/tictactoe/invites")
@login_required
def invites():
    _expire_user_invites(g.me_id)
    rows = TicTacToeMatch.query.filter(TicTacToeMatch.status.in_(("pending", "active", "expired", "declined")),
        or_(TicTacToeMatch.player_x_id == g.me_id, TicTacToeMatch.player_o_id == g.me_id)).order_by(TicTacToeMatch.created_at.desc()).limit(30).all()
    result = []
    for match in rows:
        outgoing = match.player_x_id == g.me_id
        other = db.session.get(User, match.player_o_id if outgoing else match.player_x_id)
        remaining = max(0, INVITE_TTL_SECONDS - int((datetime.utcnow() - match.created_at).total_seconds())) if match.status == "pending" else 0
        result.append({"id": match.id, "direction": "outgoing" if outgoing else "incoming",
            "sender": other.full_name if other else "Friend", "status": match.status,
            "remaining_seconds": remaining})
    return jsonify(result)


@tictactoe_bp.post("/tictactoe/matches/<int:mid>/accept")
@login_required
def accept(mid):
    match = db.session.get(TicTacToeMatch, mid)
    if match:
        _expire_invite(match)
    if not match or match.player_o_id != g.me_id or match.status != "pending":
        return jsonify(message="This invitation has expired or is no longer available."), 404
    match.status = "active"
    match.updated_at = datetime.utcnow()
    db.session.commit()
    _notify(match.player_x_id, "tictactoe_invite_accepted", {"match_id": match.id})
    return jsonify(_payload(match, g.me_id))


@tictactoe_bp.get("/tictactoe/matches/<int:mid>")
@login_required
def get_match(mid):
    match = db.session.get(TicTacToeMatch, mid)
    if not match or g.me_id not in (match.player_x_id, match.player_o_id):
        return jsonify(message="Match not found."), 404
    _expire_invite(match)
    return jsonify(_payload(match, g.me_id))


@tictactoe_bp.post("/tictactoe/matches/<int:mid>/move")
@login_required
def move(mid):
    match = db.session.get(TicTacToeMatch, mid)
    if not match or g.me_id not in (match.player_x_id, match.player_o_id):
        return jsonify(message="Match not found."), 404
    if match.status != "active":
        return jsonify(message="This match is not active."), 409
    mark = "X" if g.me_id == match.player_x_id else "O"
    if match.turn != mark:
        return jsonify(message="It is not your turn."), 409
    data = request.get_json(silent=True) or {}
    try:
        cell = int(data.get("cell"))
    except (TypeError, ValueError):
        return jsonify(message="Choose a square."), 400
    if cell < 0 or cell > 8:
        return jsonify(message="That square is outside the board."), 400
    board = json.loads(match.board_json)
    if board[cell] is not None:
        return jsonify(message="That square is already taken."), 409
    board[cell] = mark
    wins = ((0,1,2),(3,4,5),(6,7,8),(0,3,6),(1,4,7),(2,5,8),(0,4,8),(2,4,6))
    winning = any(all(board[i] == mark for i in line) for line in wins)
    match.board_json = json.dumps(board)
    if winning:
        match.status = "won"
        match.winner_id = g.me_id
    elif all(board):
        match.status = "draw"
    else:
        match.turn = "O" if mark == "X" else "X"
    match.updated_at = datetime.utcnow()
    db.session.commit()
    return jsonify(_payload(match, g.me_id))


@tictactoe_bp.post("/tictactoe/matches/<int:mid>/decline")
@login_required
def decline(mid):
    match = db.session.get(TicTacToeMatch, mid)
    if not match or match.player_o_id != g.me_id or match.status != "pending":
        return jsonify(message="Invitation not found or already expired."), 404
    match.status = "declined"
    match.updated_at = datetime.utcnow()
    db.session.commit()
    _notify(match.player_x_id, "tictactoe_invite_declined", {"match_id": match.id})
    return jsonify(ok=True)


@tictactoe_bp.post("/tictactoe/matches/<int:mid>/resign")
@login_required
def resign(mid):
    match = db.session.get(TicTacToeMatch, mid)
    if not match or g.me_id not in (match.player_x_id, match.player_o_id) or match.status != "active":
        return jsonify(message="Active match not found."), 404
    match.status = "won"
    match.winner_id = match.player_o_id if g.me_id == match.player_x_id else match.player_x_id
    match.updated_at = datetime.utcnow()
    db.session.commit()
    return jsonify(_payload(match, g.me_id))
