"""Additive World Chat + ad-hoc matchmaking blueprint for PlayHub.

Integration (add these two lines to backend/app.py; do not remove existing lines):
    from world_chat import world_chat_bp
    app.register_blueprint(world_chat_bp)

Register the blueprint before the existing app.app_context()/db.create_all() block.
This module adds three tables and does not alter existing models or routes.
Real-time sync uses authenticated cursor polling, so no new dependency is required.
"""
from datetime import datetime

from flask import Blueprint, g, jsonify, request
from sqlalchemy import CheckConstraint, UniqueConstraint, and_, func

from auth import login_required
from database import db
from models import User

world_chat_bp = Blueprint("world_chat", __name__)

MAX_WORLD_TEXT = 2000
MAX_GAME_NAME = 80
MAX_GAME_DETAILS = 500


class WorldChatMessage(db.Model):
    """Append-only public message stream; GAME_INVITATION messages link to invitation rows."""
    __tablename__ = "world_chat_messages"

    id = db.Column(db.Integer, primary_key=True)
    sender_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False, index=True)
    message_type = db.Column(db.String(24), nullable=False, default="TEXT", index=True)
    body = db.Column(db.String(MAX_WORLD_TEXT), nullable=False)
    invitation_id = db.Column(db.Integer, db.ForeignKey("world_game_invitations.id"), nullable=True, index=True)
    created_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow, index=True)

    sender = db.relationship("User", foreign_keys=[sender_id])


class WorldGameInvitation(db.Model):
    """One matchmaking broadcast and its current lifecycle/participant state."""
    __tablename__ = "world_game_invitations"

    id = db.Column(db.Integer, primary_key=True)
    host_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False, index=True)
    game_type = db.Column(db.String(MAX_GAME_NAME), nullable=False, index=True)
    details = db.Column(db.String(MAX_GAME_DETAILS), nullable=False, default="")
    state = db.Column(db.String(16), nullable=False, default="OPEN", index=True)
    max_participants = db.Column(db.Integer, nullable=False, default=4)
    created_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow, index=True)
    updated_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)

    host = db.relationship("User", foreign_keys=[host_id])
    participants = db.relationship(
        "WorldGameParticipant",
        back_populates="invitation",
        cascade="all, delete-orphan",
        order_by="WorldGameParticipant.joined_at",
    )

    __table_args__ = (
        CheckConstraint("max_participants >= 2 AND max_participants <= 100", name="ck_world_invite_capacity"),
        CheckConstraint("state IN ('OPEN', 'STARTED', 'CANCELLED', 'CLOSED')", name="ck_world_invite_state"),
    )


class WorldGameParticipant(db.Model):
    """Unique RSVP per user per invitation; LEFT rows preserve participation history."""
    __tablename__ = "world_game_participants"

    id = db.Column(db.Integer, primary_key=True)
    invitation_id = db.Column(db.Integer, db.ForeignKey("world_game_invitations.id"), nullable=False, index=True)
    user_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False, index=True)
    status = db.Column(db.String(12), nullable=False, default="JOINED")
    joined_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)

    invitation = db.relationship("WorldGameInvitation", back_populates="participants")
    user = db.relationship("User", foreign_keys=[user_id])

    __table_args__ = (
        UniqueConstraint("invitation_id", "user_id", name="uq_world_game_participant"),
        CheckConstraint("status IN ('JOINED', 'LEFT')", name="ck_world_game_participant_status"),
    )


def _iso(value):
    return value.isoformat() + "Z" if value else None


def _user_payload(user):
    return {
        "id": user.id,
        "username": user.username,
        "full_name": user.full_name,
    }


def _active_participants(invitation):
    rows = [p for p in invitation.participants if p.status == "JOINED"]
    return rows


def _invitation_payload(invitation, viewer_id):
    active = _active_participants(invitation)
    return {
        "id": invitation.id,
        "host": _user_payload(invitation.host),
        "host_id": invitation.host_id,
        "game_type": invitation.game_type,
        "details": invitation.details,
        "state": invitation.state,
        "max_participants": invitation.max_participants,
        "participant_count": len(active),
        "participants": [
            {"user": _user_payload(p.user), "joined_at": _iso(p.joined_at)}
            for p in active
        ],
        "joined_by_me": any(p.user_id == viewer_id for p in active),
        "created_at": _iso(invitation.created_at),
        "updated_at": _iso(invitation.updated_at),
    }


def _message_payload(message, viewer_id):
    invitation = db.session.get(WorldGameInvitation, message.invitation_id) if message.invitation_id else None
    return {
        "id": message.id,
        "message_type": message.message_type,
        "body": message.body,
        "sender": _user_payload(message.sender),
        "sender_id": message.sender_id,
        "invitation": _invitation_payload(invitation, viewer_id) if invitation else None,
        "created_at": _iso(message.created_at),
    }


@world_chat_bp.get("/world-chat/messages")
@login_required
def world_chat_history():
    """Fetch history with ?before_id=N, or incremental updates with ?after_id=N."""
    try:
        limit = min(max(int(request.args.get("limit", 50)), 1), 100)
        after_id = max(int(request.args.get("after_id", 0)), 0)
        before_id = int(request.args["before_id"]) if request.args.get("before_id") else None
    except (TypeError, ValueError):
        return jsonify({"message": "Invalid message cursor or limit."}), 400

    query = WorldChatMessage.query
    if after_id:
        query = query.filter(WorldChatMessage.id > after_id)
    if before_id is not None:
        query = query.filter(WorldChatMessage.id < before_id)

    rows = query.order_by(WorldChatMessage.id.desc()).limit(limit).all()
    rows.reverse()
    return jsonify({
        "messages": [_message_payload(row, g.me_id) for row in rows],
        "next_before_id": rows[0].id if rows else before_id,
        "last_id": rows[-1].id if rows else after_id,
    })


@world_chat_bp.post("/world-chat/messages")
@login_required
def world_chat_send_message():
    data = request.get_json(silent=True) or {}
    body = (data.get("body") or "").strip()
    if not body:
        return jsonify({"message": "Message cannot be empty."}), 400
    if len(body) > MAX_WORLD_TEXT:
        return jsonify({"message": f"Messages may contain at most {MAX_WORLD_TEXT} characters."}), 400

    message = WorldChatMessage(sender_id=g.me_id, message_type="TEXT", body=body)
    db.session.add(message)
    db.session.commit()
    return jsonify({"message": _message_payload(message, g.me_id)}), 201


@world_chat_bp.post("/world-chat/invitations")
@login_required
def world_chat_create_invitation():
    """Create an invitation and broadcast its invitation card into the global stream."""
    data = request.get_json(silent=True) or {}
    game_type = (data.get("game_type") or "").strip()
    details = (data.get("details") or "").strip()
    try:
        capacity = int(data.get("max_participants", 4))
    except (TypeError, ValueError):
        return jsonify({"message": "max_participants must be a number."}), 400

    if not game_type or len(game_type) > MAX_GAME_NAME:
        return jsonify({"message": f"game_type is required and must be at most {MAX_GAME_NAME} characters."}), 400
    if len(details) > MAX_GAME_DETAILS:
        return jsonify({"message": f"details may contain at most {MAX_GAME_DETAILS} characters."}), 400
    if not 2 <= capacity <= 100:
        return jsonify({"message": "max_participants must be between 2 and 100."}), 400

    invitation = WorldGameInvitation(
        host_id=g.me_id,
        game_type=game_type,
        details=details,
        max_participants=capacity,
        state="OPEN",
    )
    db.session.add(invitation)
    db.session.flush()

    # Host is automatically on the roster, so the participant counter starts at one.
    db.session.add(WorldGameParticipant(invitation_id=invitation.id, user_id=g.me_id, status="JOINED"))
    text = f"Looking for players for {game_type}"
    if details:
        text += f" — {details}"
    message = WorldChatMessage(
        sender_id=g.me_id,
        message_type="GAME_INVITATION",
        body=text,
        invitation_id=invitation.id,
    )
    db.session.add(message)
    db.session.commit()

    return jsonify({
        "message": _message_payload(message, g.me_id),
        "invitation": _invitation_payload(invitation, g.me_id),
    }), 201


@world_chat_bp.post("/world-chat/invitations/<int:invitation_id>/join")
@login_required
def world_chat_join_invitation(invitation_id):
    invitation = db.session.get(WorldGameInvitation, invitation_id)
    if not invitation:
        return jsonify({"message": "Invitation not found."}), 404
    if invitation.state != "OPEN":
        return jsonify({"message": "This invitation is no longer open."}), 409

    participant = WorldGameParticipant.query.filter_by(
        invitation_id=invitation.id, user_id=g.me_id
    ).first()
    active = _active_participants(invitation)

    if participant and participant.status == "JOINED":
        return jsonify({"invitation": _invitation_payload(invitation, g.me_id), "message": "You have already joined."}), 200
    if len(active) >= invitation.max_participants:
        return jsonify({"message": "This game invitation is full."}), 409

    if participant:
        participant.status = "JOINED"
        participant.updated_at = datetime.utcnow()
    else:
        db.session.add(WorldGameParticipant(invitation_id=invitation.id, user_id=g.me_id, status="JOINED"))

    invitation.updated_at = datetime.utcnow()
    db.session.commit()
    return jsonify({"invitation": _invitation_payload(invitation, g.me_id)}), 200


@world_chat_bp.post("/world-chat/invitations/<int:invitation_id>/leave")
@login_required
def world_chat_leave_invitation(invitation_id):
    invitation = db.session.get(WorldGameInvitation, invitation_id)
    if not invitation:
        return jsonify({"message": "Invitation not found."}), 404

    participant = WorldGameParticipant.query.filter_by(
        invitation_id=invitation.id, user_id=g.me_id
    ).first()
    if not participant or participant.status != "JOINED":
        return jsonify({"message": "You are not an active participant."}), 409
    if invitation.host_id == g.me_id:
        return jsonify({"message": "The host cannot leave their own invitation. Cancel it instead."}), 409

    participant.status = "LEFT"
    participant.updated_at = datetime.utcnow()
    invitation.updated_at = datetime.utcnow()
    db.session.commit()
    return jsonify({"invitation": _invitation_payload(invitation, g.me_id)}), 200


@world_chat_bp.post("/world-chat/invitations/<int:invitation_id>/state")
@login_required
def world_chat_update_invitation_state(invitation_id):
    """Only the host may change OPEN -> STARTED/CANCELLED/CLOSED."""
    data = request.get_json(silent=True) or {}
    state = (data.get("state") or "").strip().upper()
    if state not in {"STARTED", "CANCELLED", "CLOSED"}:
        return jsonify({"message": "state must be STARTED, CANCELLED, or CLOSED."}), 400

    invitation = db.session.get(WorldGameInvitation, invitation_id)
    if not invitation:
        return jsonify({"message": "Invitation not found."}), 404
    if invitation.host_id != g.me_id:
        return jsonify({"message": "Only the host can update this invitation."}), 403
    if invitation.state != "OPEN":
        return jsonify({"message": "Only open invitations can be updated."}), 409

    invitation.state = state
    invitation.updated_at = datetime.utcnow()
    db.session.commit()
    return jsonify({"invitation": _invitation_payload(invitation, g.me_id)}), 200
