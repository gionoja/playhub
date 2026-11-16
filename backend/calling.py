"""Vynqo call invitations and lifecycle, with LiveKit handling realtime media."""
from datetime import datetime, timedelta
import uuid
import os

from flask import Blueprint, current_app, g, jsonify, request
from flask_socketio import emit, join_room
from itsdangerous import BadSignature, SignatureExpired
from sqlalchemy import and_, or_

from auth import TOKEN_MAX_AGE, _password_stamp, _serializer, login_required
from database import db
from models import AuthSession, CallSession, Friendship, Profile, User, UserBlock
from profiles import avatar_url

calling_bp = Blueprint("calling", __name__)
socketio = None
DEFAULT_RING_TIMEOUT_SECONDS = 60


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



def _socket_user_id():
    from flask import request as socket_request
    return socket_request.environ.get("vynqo_user_id")


def _user_room(user_id):
    return f"vynqo_user_{user_id}"


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


def _ring_timeout_seconds():
    try:
        return max(10, int(current_app.config.get(
            "CALL_RING_TIMEOUT_SECONDS", DEFAULT_RING_TIMEOUT_SECONDS)))
    except (TypeError, ValueError):
        return DEFAULT_RING_TIMEOUT_SECONDS


def _emit_call_ended(call, status):
    payload = {"call_id": call.id, "status": status}
    _emit_user(call.caller_id, "call_ended", payload)
    _emit_user(call.callee_id, "call_ended", payload)


def _expire_call(call):
    """Atomically transition a stale ringing call once; safe to call repeatedly."""
    if call.status != "ringing":
        return False
    if call.created_at > datetime.utcnow() - timedelta(seconds=_ring_timeout_seconds()):
        return False
    changed = CallSession.query.filter_by(id=call.id, status="ringing").update(
        {"status": "missed", "ended_at": datetime.utcnow()}, synchronize_session=False)
    if changed:
        db.session.commit()
        db.session.refresh(call)
        _emit_call_ended(call, "missed")
        return True
    db.session.rollback()
    return False


def _expire_stale_calls():
    cutoff = datetime.utcnow() - timedelta(seconds=_ring_timeout_seconds())
    stale = CallSession.query.filter(
        CallSession.status == "ringing", CallSession.created_at <= cutoff).all()
    for call in stale:
        _expire_call(call)


def _schedule_ring_timeout(call_id):
    """Server-side timeout survives recipient refreshes while this server is running."""
    app = current_app._get_current_object()
    seconds = _ring_timeout_seconds()

    def expire_later():
        socketio.sleep(seconds)
        with app.app_context():
            call = db.session.get(CallSession, call_id)
            if call:
                _expire_call(call)

    if socketio:
        socketio.start_background_task(expire_later)


def _person(user):
    profile = Profile.query.filter_by(user_id=user.id).first()
    photo = avatar_url(user.id) if profile and profile.avatar_filename else None
    return {"id": user.id, "full_name": user.full_name, "username": user.username,
            "avatar_url": photo,
            "last_seen": profile.last_seen.isoformat() + "Z" if profile and profile.last_seen else None}


def _call_view(call, me_id):
    other = call.callee if me_id == call.caller_id else call.caller
    return {"id": call.id, "type": call.call_type, "status": call.status,
            "direction": "outgoing" if me_id == call.caller_id else "incoming",
            "created_at": call.created_at.isoformat() + "Z",
            "answered_at": call.answered_at.isoformat() + "Z" if call.answered_at else None,
            "ended_at": call.ended_at.isoformat() + "Z" if call.ended_at else None,
            "ring_timeout_seconds": _ring_timeout_seconds(),
            "duration_seconds": max(0, int((call.ended_at - call.answered_at).total_seconds()))
                if call.answered_at and call.ended_at else None,
            "other_user": _person(other)}


def _emit_user(user_id, event, payload):
    if socketio:
        socketio.emit(event, payload, room=_user_room(user_id))


def _finish(call, status, allowed_statuses=("ringing", "accepted")):
    now = datetime.utcnow()
    changed = CallSession.query.filter(
        CallSession.id == call.id,
        CallSession.status.in_(allowed_statuses)
    ).update({"status": status, "ended_at": now}, synchronize_session=False)
    if not changed:
        db.session.rollback()
        return jsonify({"message": "This call has already ended"}), 409
    db.session.commit()
    db.session.refresh(call)
    _emit_call_ended(call, status)
    return jsonify({"call": _call_view(call, g.me_id)})


@calling_bp.route("/calls/<call_id>/livekit-token", methods=["POST"])
@login_required
def livekit_call_token(call_id):
    """Issue a short-lived LiveKit token only to an accepted call participant."""
    call, error = _participant_call(call_id)
    if error:
        return error
    if call.status != "accepted":
        return jsonify({"message": "Accept the call before joining its media room"}), 409
    if _blocked(call.caller_id, call.callee_id) or not _are_friends(call.caller_id, call.callee_id):
        return jsonify({"message": "This call is no longer available"}), 403

    livekit_url = os.getenv("LIVEKIT_URL")
    api_key = os.getenv("LIVEKIT_API_KEY")
    api_secret = os.getenv("LIVEKIT_API_SECRET")
    if not all((livekit_url, api_key, api_secret)):
        current_app.logger.error("LiveKit credentials are not configured")
        return jsonify({"message": "LiveKit calling is not configured on the server"}), 503

    try:
        from livekit import api
        participant = db.session.get(User, g.me_id)
        token = (
            api.AccessToken(api_key, api_secret)
            .with_identity(f"playhub-user-{g.me_id}")
            .with_name(participant.full_name if participant else f"User {g.me_id}")
            .with_ttl(timedelta(minutes=10))
            .with_grants(api.VideoGrants(
                room_join=True,
                room=call.id,
                can_publish=True,
                can_subscribe=True,
            ))
            .to_jwt()
        )
    except Exception:
        current_app.logger.exception("Could not create LiveKit access token")
        return jsonify({"message": "Could not prepare the secure call connection"}), 500

    return jsonify({"server_url": livekit_url, "participant_token": token})


@calling_bp.route("/calls", methods=["POST"])
@login_required
def create_call():
    _expire_stale_calls()
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
    busy = CallSession.query.filter(
        or_(CallSession.status == "accepted", CallSession.status == "ringing"),
        or_(CallSession.caller_id.in_([g.me_id, target_id]),
            CallSession.callee_id.in_([g.me_id, target_id])),
    ).first()
    if busy:
        return jsonify({"message": "One of you is already in a call"}), 409
    call = CallSession(id=str(uuid.uuid4()), caller_id=g.me_id, callee_id=target_id,
                       call_type=call_type, status="ringing")
    db.session.add(call)
    db.session.commit()
    _emit_user(target_id, "incoming_call", _call_view(call, target_id))
    _schedule_ring_timeout(call.id)
    return jsonify({"call": _call_view(call, g.me_id)}), 201


@calling_bp.route("/calls/active")
@login_required
def active_call():
    _expire_stale_calls()
    call = CallSession.query.filter(CallSession.status.in_(["ringing", "accepted"]),
        or_(CallSession.caller_id == g.me_id, CallSession.callee_id == g.me_id)
    ).order_by(CallSession.created_at.desc()).first()
    return jsonify({"call": _call_view(call, g.me_id) if call else None})


@calling_bp.route("/calls/history")
@login_required
def call_history():
    _expire_stale_calls()
    try:
        limit = min(100, max(1, int(request.args.get("limit", 50))))
    except (TypeError, ValueError):
        limit = 50
    calls = CallSession.query.filter(
        or_(CallSession.caller_id == g.me_id, CallSession.callee_id == g.me_id)
    ).order_by(CallSession.created_at.desc()).limit(limit).all()
    return jsonify({"calls": [_call_view(call, g.me_id) for call in calls]})


def _participant_call(call_id):
    call = _get_call(call_id)
    if not call or g.me_id not in (call.caller_id, call.callee_id):
        return None, (jsonify({"message": "Call not found"}), 404)
    return call, None


@calling_bp.route("/calls/<call_id>/accept", methods=["POST"])
@login_required
def accept_call(call_id):
    _expire_stale_calls()
    call, error = _participant_call(call_id)
    if error: return error
    if call.callee_id != g.me_id or call.status != "ringing":
        return jsonify({"message": "This call can no longer be accepted"}), 409
    if _blocked(call.caller_id, call.callee_id) or not _are_friends(call.caller_id, call.callee_id):
        call.status = "cancelled"; call.ended_at = datetime.utcnow(); db.session.commit()
        _emit_call_ended(call, "cancelled")
        return jsonify({"message": "This call is no longer available"}), 403
    now = datetime.utcnow()
    changed = CallSession.query.filter(
        CallSession.id == call.id,
        CallSession.status == "ringing",
        CallSession.created_at > now - timedelta(seconds=_ring_timeout_seconds())
    ).update({"status": "accepted", "answered_at": now}, synchronize_session=False)
    if not changed:
        db.session.rollback()
        return jsonify({"message": "This call has expired and can no longer be accepted"}), 409
    db.session.commit()
    db.session.refresh(call)
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
    return _finish(call, "rejected", allowed_statuses=("ringing",))


@calling_bp.route("/calls/<call_id>/cancel", methods=["POST"])
@login_required
def cancel_call(call_id):
    call, error = _participant_call(call_id)
    if error: return error
    if call.caller_id != g.me_id or call.status != "ringing":
        return jsonify({"message": "This outgoing call can no longer be cancelled"}), 409
    return _finish(call, "cancelled", allowed_statuses=("ringing",))


@calling_bp.route("/calls/<call_id>/end", methods=["POST"])
@login_required
def end_call(call_id):
    call, error = _participant_call(call_id)
    if error: return error
    return _finish(call, "ended")
