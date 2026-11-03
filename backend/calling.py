"""Vynqo's in-app audio/video call invitations and WebRTC signalling."""
from datetime import datetime, timedelta
import uuid

from flask import Blueprint, current_app, g, jsonify, request
from flask_socketio import emit, join_room
from itsdangerous import BadSignature, SignatureExpired
from sqlalchemy import and_, or_

from auth import TOKEN_MAX_AGE, _password_stamp, _serializer, login_required
from database import db
from models import AuthSession, CallSession, Friendship, Profile, User, UserBlock

calling_bp = Blueprint("calling", __name__)
socketio = None


def init_calling_socket(socket_server):
    global socketio
    socketio = socket_server

    @socket_server.on("connect")
    def call_socket_connect(auth=None):
        token = (auth or {}).get("token") if isinstance(auth, dict) else None
        if not token:
            return False
        try:
            payload = _serializer().loads(token, max_age=TOKEN_MAX_AGE)
        except (BadSignature, SignatureExpired):
            return False
        user = db.session.get(User, payload.get("uid"))
        session = db.session.get(AuthSession, payload.get("sid"))
        now = datetime.utcnow()
        if (not user or not user.email_verified or payload.get("pv") != _password_stamp(user)
                or not session or session.user_id != user.id or session.revoked_at is not None
                or session.expires_at < now):
            return False
        from flask import request as socket_request
        socket_request.environ["vynqo_user_id"] = user.id
        join_room(_user_room(user.id))
        emit("call_socket_ready", {"ok": True})

    @socket_server.on("rtc_signal")
    def relay_rtc_signal(data):
        data = data if isinstance(data, dict) else {}
        user_id = _socket_user_id()
        call = _get_call(data.get("call_id"))
        if not user_id or not call or call.status != "accepted":
            return
        if user_id not in (call.caller_id, call.callee_id):
            return
        target_id = call.callee_id if user_id == call.caller_id else call.caller_id
        kind = data.get("kind")
        if kind not in ("offer", "answer", "ice"):
            return
        payload = data.get("payload")
        if not isinstance(payload, dict):
            return
        emit("rtc_signal", {"call_id": call.id, "from_user_id": user_id,
                             "kind": kind, "payload": payload}, room=_user_room(target_id))

    @socket_server.on("call_client_ready")
    def rejoin_call_room(data):
        user_id = _socket_user_id()
        call = _get_call((data or {}).get("call_id")) if isinstance(data, dict) else None
        if user_id and call and call.status == "accepted" and user_id in (call.caller_id, call.callee_id):
            join_room(_call_room(call.id))
            return {"ok": True}
        return {"ok": False}


def _socket_user_id():
    from flask import request as socket_request
    return socket_request.environ.get("vynqo_user_id")


def _user_room(user_id):
    return f"vynqo_user_{user_id}"


def _call_room(call_id):
    return f"vynqo_call_{call_id}"


def _get_call(call_id):
    if not call_id or not isinstance(call_id, str):
        return None
    return db.session.get(CallSession, call_id)


def _pair(a, b):
    return (a, b) if a < b else (b, a)


def _blocked(a, b):
    return UserBlock.query.filter(or_(
        and_(UserBlock.blocker_id == a, UserBlock.blocked_id == b),
        and_(UserBlock.blocker_id == b, UserBlock.blocked_id == a),
    )).first() is not None


def _are_friends(a, b):
    low, high = _pair(a, b)
    return Friendship.query.filter_by(user_low_id=low, user_high_id=high).first() is not None


def _person(user):
    profile = Profile.query.filter_by(user_id=user.id).first()
    return {"id": user.id, "full_name": user.full_name, "username": user.username,
            "avatar_url": None, "last_seen": profile.last_seen.isoformat() + "Z" if profile and profile.last_seen else None}


def _call_view(call, me_id):
    other = call.callee if me_id == call.caller_id else call.caller
    return {"id": call.id, "type": call.call_type, "status": call.status,
            "direction": "outgoing" if me_id == call.caller_id else "incoming",
            "created_at": call.created_at.isoformat() + "Z",
            "answered_at": call.answered_at.isoformat() + "Z" if call.answered_at else None,
            "other_user": _person(other)}


def _emit_user(user_id, event, payload):
    if socketio:
        socketio.emit(event, payload, room=_user_room(user_id))


def _finish(call, status):
    call.status = status
    call.ended_at = datetime.utcnow()
    db.session.commit()
    other_id = call.callee_id if g.me_id == call.caller_id else call.caller_id
    view = _call_view(call, g.me_id)
    _emit_user(other_id, "call_ended", {"call_id": call.id, "status": status})
    _emit_user(g.me_id, "call_ended", {"call_id": call.id, "status": status})
    return jsonify({"call": view})


@calling_bp.route("/calls", methods=["POST"])
@login_required
def create_call():
    data = request.get_json(silent=True) or {}
    target_id = data.get("user_id")
    call_type = data.get("type", "audio")
    if call_type not in ("audio", "video"):
        return jsonify({"message": "Choose audio or video calling"}), 400
    try:
        target_id = int(target_id)
    except (TypeError, ValueError):
        return jsonify({"message": "Choose a valid friend"}), 400
    if target_id == g.me_id:
        return jsonify({"message": "You cannot call yourself"}), 400
    target = db.session.get(User, target_id)
    if not target or not target.email_verified:
        return jsonify({"message": "That user is unavailable"}), 404
    if _blocked(g.me_id, target_id):
        return jsonify({"message": "Calling is unavailable because one of you has blocked the other"}), 403
    if not _are_friends(g.me_id, target_id):
        return jsonify({"message": "You can only call your Vynqo friends"}), 403
    cutoff = datetime.utcnow() - timedelta(seconds=90)
    busy = CallSession.query.filter(
        or_(
            CallSession.status == "accepted",
            and_(CallSession.status == "ringing", CallSession.created_at >= cutoff),
        ),
        or_(CallSession.caller_id.in_([g.me_id, target_id]),
            CallSession.callee_id.in_([g.me_id, target_id])),
    ).first()
    if busy:
        return jsonify({"message": "One of you is already in a call"}), 409
    call = CallSession(id=str(uuid.uuid4()), caller_id=g.me_id, callee_id=target_id,
                       call_type=call_type, status="ringing")
    db.session.add(call)
    db.session.commit()
    payload = {"call": _call_view(call, target_id)}
    _emit_user(target_id, "incoming_call", payload["call"])
    return jsonify({"call": _call_view(call, g.me_id)}), 201


@calling_bp.route("/calls/active")
@login_required
def active_call():
    call = CallSession.query.filter(CallSession.status.in_(["ringing", "accepted"]),
        or_(CallSession.caller_id == g.me_id, CallSession.callee_id == g.me_id)
    ).order_by(CallSession.created_at.desc()).first()
    if call and call.status == "ringing" and call.created_at < datetime.utcnow() - timedelta(seconds=60):
        call.status = "missed"
        call.ended_at = datetime.utcnow()
        db.session.commit()
        call = None
    return jsonify({"call": _call_view(call, g.me_id) if call else None})


def _participant_call(call_id):
    call = _get_call(call_id)
    if not call or g.me_id not in (call.caller_id, call.callee_id):
        return None, (jsonify({"message": "Call not found"}), 404)
    return call, None


@calling_bp.route("/calls/<call_id>/accept", methods=["POST"])
@login_required
def accept_call(call_id):
    call, error = _participant_call(call_id)
    if error: return error
    if call.callee_id != g.me_id or call.status != "ringing":
        return jsonify({"message": "This call can no longer be accepted"}), 409
    if _blocked(call.caller_id, call.callee_id) or not _are_friends(call.caller_id, call.callee_id):
        call.status = "cancelled"; call.ended_at = datetime.utcnow(); db.session.commit()
        return jsonify({"message": "This call is no longer available"}), 403
    call.status = "accepted"
    call.answered_at = datetime.utcnow()
    db.session.commit()
    _emit_user(call.caller_id, "call_accepted", {"call": _call_view(call, call.caller_id)})
    _emit_user(call.callee_id, "call_accepted", {"call": _call_view(call, call.callee_id)})
    return jsonify({"call": _call_view(call, g.me_id)})


@calling_bp.route("/calls/<call_id>/reject", methods=["POST"])
@login_required
def reject_call(call_id):
    call, error = _participant_call(call_id)
    if error: return error
    if call.callee_id != g.me_id or call.status != "ringing":
        return jsonify({"message": "This call can no longer be declined"}), 409
    return _finish(call, "rejected")


@calling_bp.route("/calls/<call_id>/cancel", methods=["POST"])
@login_required
def cancel_call(call_id):
    call, error = _participant_call(call_id)
    if error: return error
    if call.caller_id != g.me_id or call.status != "ringing":
        return jsonify({"message": "This outgoing call can no longer be cancelled"}), 409
    return _finish(call, "cancelled")


@calling_bp.route("/calls/<call_id>/end", methods=["POST"])
@login_required
def end_call(call_id):
    call, error = _participant_call(call_id)
    if error: return error
    if call.status not in ("ringing", "accepted"):
        return jsonify({"message": "This call has already ended"}), 409
    return _finish(call, "ended")
