"""Private conversations between friends: text and image messages, unread counts."""
from datetime import datetime, timedelta

from flask import (
    Blueprint, abort, current_app, g, jsonify, request, send_from_directory
)
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from sqlalchemy import func, or_
from sqlalchemy.exc import IntegrityError

from auth import login_required
from database import db
from models import Conversation, Friendship, Message, Profile, User
from uploads import (
    MAX_IMAGE_BYTES, MESSAGE_DIR, MIME, SAFE_NAME, delete_upload_files,
    detect_image_type, save_message_image
)

messages_bp = Blueprint("messages", __name__)

MAX_TEXT = 2000
PAGE_SIZE = 50
ONLINE_WINDOW = timedelta(minutes=3)


# ---------------------------------------------------------------- helpers

def _error(message, status):
    return jsonify({"message": message}), status


def _iso(dt):
    return dt.isoformat() + "Z" if dt else None


def _pair(a, b):
    return (a, b) if a < b else (b, a)


def _are_friends(a, b):
    low, high = _pair(a, b)
    return Friendship.query.filter_by(
        user_low_id=low, user_high_id=high
    ).first() is not None


def _find_conversation(a, b):
    low, high = _pair(a, b)
    return Conversation.query.filter_by(
        user_low_id=low, user_high_id=high
    ).first()


def _is_online(user_id):
    profile = Profile.query.filter_by(user_id=user_id).first()
    return bool(
        profile and profile.last_seen
        and datetime.utcnow() - profile.last_seen < ONLINE_WINDOW
    )


def _other_info(user):
    return {
        "full_name": user.full_name,
        "username": user.username,
        "online": _is_online(user.id),
    }


def _other_user(username):
    """The person on the other side of a conversation, or None."""
    user = User.query.filter_by(username=username).first()

    if not user or not user.email_verified or user.id == g.me_id:
        return None

    return user


def _image_serializer():
    return URLSafeTimedSerializer(
        current_app.config["SECRET_KEY"], salt="playhub-image"
    )


def _image_url(filename, user_id):
    # <img> tags cannot send a login header, so the URL itself carries a
    # signed, expiring pass that is tied to this user and this file.
    token = _image_serializer().dumps({"f": filename, "u": user_id})
    return f"/messages/images/{filename}?t={token}"


def _message_dict(m):
    return {
        "id": m.id,
        "mine": m.sender_id == g.me_id,
        "type": m.message_type,
        "text": m.body or "",
        "image_url": _image_url(m.image_filename, g.me_id) if m.image_filename else None,
        "created_at": _iso(m.created_at),
        "read": m.read_at is not None,
    }


def _seen_up_to(conversation_id):
    """Highest id of my messages the other person has already read."""
    return db.session.query(func.max(Message.id)).filter(
        Message.conversation_id == conversation_id,
        Message.sender_id == g.me_id,
        Message.read_at.isnot(None),
    ).scalar() or 0


# ------------------------------------------------------- conversation list

@messages_bp.route("/conversations")
@login_required
def list_conversations():
    me = g.me_id

    convs = Conversation.query.filter(
        or_(Conversation.user_low_id == me, Conversation.user_high_id == me),
        Conversation.last_message_at.isnot(None),
    ).order_by(Conversation.last_message_at.desc()).limit(100).all()

    if not convs:
        return jsonify([])

    ids = [c.id for c in convs]

    unread = dict(
        db.session.query(Message.conversation_id, func.count(Message.id))
        .filter(
            Message.conversation_id.in_(ids),
            Message.sender_id != me,
            Message.read_at.is_(None),
        )
        .group_by(Message.conversation_id)
        .all()
    )

    last_ids = [
        row[0] for row in db.session.query(func.max(Message.id))
        .filter(Message.conversation_id.in_(ids))
        .group_by(Message.conversation_id)
        .all()
    ]
    last = {m.conversation_id: m for m in Message.query.filter(Message.id.in_(last_ids)).all()}

    other_ids = [c.user_high_id if c.user_low_id == me else c.user_low_id for c in convs]
    users = {u.id: u for u in User.query.filter(User.id.in_(other_ids)).all()}

    result = []

    for c, other_id in zip(convs, other_ids):
        other = users.get(other_id)
        m = last.get(c.id)

        if not other or not m:
            continue

        preview = "Photo" if m.message_type == "IMAGE" and not m.body else (m.body or "")

        result.append({
            "user": _other_info(other),
            "unread": unread.get(c.id, 0),
            "last": {
                "type": m.message_type,
                "text": preview[:80],
                "mine": m.sender_id == me,
                "created_at": _iso(m.created_at),
            },
        })

    return jsonify(result)


@messages_bp.route("/messages/unread-count")
@login_required
def unread_count():
    me = g.me_id

    count = db.session.query(func.count(Message.id)).join(
        Conversation, Message.conversation_id == Conversation.id
    ).filter(
        or_(Conversation.user_low_id == me, Conversation.user_high_id == me),
        Message.sender_id != me,
        Message.read_at.is_(None),
    ).scalar()

    return jsonify({"count": count or 0})


# ---------------------------------------------------------------- messages

@messages_bp.route("/conversations/<username>/messages")
@login_required
def get_messages(username):
    other = _other_user(username)

    if not other:
        return _error("User not found", 404)

    friends = _are_friends(g.me_id, other.id)
    conv = _find_conversation(g.me_id, other.id)

    base = {
        "other": _other_info(other),
        "can_message": friends,
        "messages": [],
        "has_more": False,
        "seen_up_to": 0,
    }

    if not conv:
        return jsonify(base)

    query = Message.query.filter_by(conversation_id=conv.id)

    after_id = request.args.get("after_id", type=int)
    before_id = request.args.get("before_id", type=int)

    if after_id:
        messages = query.filter(Message.id > after_id).order_by(Message.id.asc()).limit(200).all()
    else:
        if before_id:
            query = query.filter(Message.id < before_id)

        rows = query.order_by(Message.id.desc()).limit(PAGE_SIZE + 1).all()
        base["has_more"] = len(rows) > PAGE_SIZE
        messages = list(reversed(rows[:PAGE_SIZE]))

    # Opening the chat (or polling it while open) means their messages were seen
    if not before_id:
        updated = Message.query.filter(
            Message.conversation_id == conv.id,
            Message.sender_id == other.id,
            Message.read_at.is_(None),
        ).update({"read_at": datetime.utcnow()}, synchronize_session=False)

        if updated:
            db.session.commit()

    base["messages"] = [_message_dict(m) for m in messages]
    base["seen_up_to"] = _seen_up_to(conv.id)

    return jsonify(base)


@messages_bp.route("/conversations/<username>/messages", methods=["POST"])
@login_required
def send_message(username):
    other = _other_user(username)

    if not other:
        return _error("User not found", 404)

    if not _are_friends(g.me_id, other.id):
        return _error("You can only message people you are friends with", 403)

    upload = None

    if (request.content_type or "").startswith("multipart/form-data"):
        text = request.form.get("text") or ""
        upload = request.files.get("image")
    else:
        text = (request.get_json(silent=True) or {}).get("text") or ""

    text = text.strip()

    if len(text) > MAX_TEXT:
        return _error(f"Messages can be up to {MAX_TEXT} characters", 400)

    if not text and not upload:
        return _error("Write a message or choose an image", 400)

    saved_name = None

    if upload:
        data = upload.read(MAX_IMAGE_BYTES + 1)

        if len(data) > MAX_IMAGE_BYTES:
            return _error("That image is too large. The limit is 5 MB.", 413)

        kind = detect_image_type(data[:16])

        if not kind:
            return _error("Only JPG, PNG, GIF or WebP images are allowed", 400)

        saved_name = save_message_image(data, kind)

    conv = _find_conversation(g.me_id, other.id)

    if not conv:
        low, high = _pair(g.me_id, other.id)
        conv = Conversation(user_low_id=low, user_high_id=high)
        db.session.add(conv)

        try:
            db.session.commit()
        except IntegrityError:
            # The other person created it at the same moment
            db.session.rollback()
            conv = _find_conversation(g.me_id, other.id)

    message = Message(
        conversation_id=conv.id,
        sender_id=g.me_id,
        message_type="IMAGE" if saved_name else "TEXT",
        body=text or None,
        image_filename=saved_name,
    )
    db.session.add(message)
    conv.last_message_at = datetime.utcnow()

    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        if saved_name:
            delete_upload_files([saved_name])
        return _error("Message could not be sent. Please try again.", 500)

    return jsonify(_message_dict(message)), 201


# ------------------------------------------------------------------ images

@messages_bp.route("/messages/images/<filename>")
def message_image(filename):
    if not SAFE_NAME.match(filename):
        abort(404)

    try:
        payload = _image_serializer().loads(
            request.args.get("t", ""), max_age=60 * 60 * 24
        )
    except (BadSignature, SignatureExpired):
        abort(404)

    if payload.get("f") != filename:
        abort(404)

    message = Message.query.filter_by(image_filename=filename).first()
    conv = db.session.get(Conversation, message.conversation_id) if message else None

    # Only the two people in the conversation may ever see the image
    if not conv or payload.get("u") not in (conv.user_low_id, conv.user_high_id):
        abort(404)

    response = send_from_directory(
        MESSAGE_DIR,
        filename,
        mimetype=MIME[filename.rsplit(".", 1)[1]],
    )
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Cache-Control"] = "private, max-age=3600"
    return response