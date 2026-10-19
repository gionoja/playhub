"""Private conversations between friends: text and image messages, unread counts."""
from datetime import datetime, timedelta

from flask import (
    Blueprint, abort, current_app, g, jsonify, request, send_from_directory
)
from sqlalchemy import func, or_
from sqlalchemy.exc import IntegrityError

from auth import login_required
from database import db
from models import (Conversation, FriendRequest, Friendship, Message, MessageReaction, ChatPreference, ChatTyping, Profile, User, UserBlock, UserReport)
from profiles import avatar_url, preload_avatars
from signing import signed_url, verified_viewer
from uploads import (
    MAX_IMAGE_BYTES, MESSAGE_DIR, MIME, SAFE_NAME, AUDIO_NAME, ImageProblem,
    delete_upload_files, detect_image_type, detect_audio_type, prepare_image,
    save_message_image, save_message_audio
)

messages_bp = Blueprint("messages", __name__)

MAX_TEXT = 2000
MAX_AUDIO_BYTES = 5 * 1024 * 1024
PAGE_SIZE = 50
ALLOWED_STICKERS = {"heart", "laugh", "wow", "sad", "celebrate", "thumbs_up", "fire", "love"}
ALLOWED_REACTIONS = {"❤️", "😂", "👍", "😮", "😢", "🔥", "👏"}
ALLOWED_THEMES = {"default", "ocean", "sunset", "forest", "lavender"}
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


def _block_between(a, b):
    return UserBlock.query.filter(
        or_(
            (UserBlock.blocker_id == a) & (UserBlock.blocked_id == b),
            (UserBlock.blocker_id == b) & (UserBlock.blocked_id == a),
        )
    ).first()


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
        "avatar_url": avatar_url(user.id),
        "online": _is_online(user.id),
    }


def _other_user(username):
    """The person on the other side of a conversation, or None."""
    user = User.query.filter_by(username=username).first()

    if not user or not user.email_verified or user.id == g.me_id:
        return None

    return user


def _image_url(filename, user_id):
    # stays the same all day, so browsers can cache the picture
    return signed_url("messages", filename, user_id)


def _message_dict(m):
    reactions = db.session.query(
        MessageReaction.emoji, func.count(MessageReaction.id)
    ).filter_by(message_id=m.id).group_by(MessageReaction.emoji).all()
    mine_reactions = {r.emoji for r in MessageReaction.query.filter_by(
        message_id=m.id, user_id=g.me_id
    ).all()}
    reply = db.session.get(Message, m.reply_to_id) if m.reply_to_id else None
    return {
        "id": m.id,
        "mine": m.sender_id == g.me_id,
        "type": m.message_type,
        "text": m.body or "",
        "image_url": _image_url(m.image_filename, g.me_id) if m.image_filename else None,
        "audio_url": signed_url("messages", m.audio_filename, g.me_id, segment="audio") if m.audio_filename else None,
        "sticker": m.sticker_key,
        "reply_to": ({"id": reply.id, "text": reply.body or ("Photo" if reply.image_filename else "Voice note" if reply.audio_filename else reply.sticker_key or "Message"), "mine": reply.sender_id == g.me_id} if reply else None),
        "edited": m.edited_at is not None,
        "reactions": [{"emoji": emoji, "count": count, "mine": emoji in mine_reactions} for emoji, count in reactions],
        "created_at": _iso(m.created_at),
        "read": m.read_at is not None,
    }


def _theme_for(conversation_id, user_id):
    pref = ChatPreference.query.filter_by(conversation_id=conversation_id, user_id=user_id).first()
    return pref.theme if pref else "default"


def _other_typing(conversation_id, other_id):
    row = ChatTyping.query.filter_by(conversation_id=conversation_id, user_id=other_id).first()
    return bool(row and datetime.utcnow() - row.updated_at < timedelta(seconds=7))


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
    preload_avatars(other_ids)

    result = []

    for c, other_id in zip(convs, other_ids):
        other = users.get(other_id)
        m = last.get(c.id)

        if not other or not m:
            continue

        if m.message_type == "IMAGE" and not m.body:
            preview = "Photo"
        elif m.message_type == "AUDIO":
            preview = "Voice note"
        elif m.message_type == "STICKER":
            preview = "Sticker"
        else:
            preview = m.body or ""

        blocked = _block_between(me, other_id) is not None
        result.append({
            "user": _other_info(other),
            "blocked": blocked,
            "blocked_by_me": UserBlock.query.filter_by(blocker_id=me, blocked_id=other_id).first() is not None,
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
    block = _block_between(g.me_id, other.id)
    blocked_by_me = UserBlock.query.filter_by(blocker_id=g.me_id, blocked_id=other.id).first() is not None
    conv = _find_conversation(g.me_id, other.id)

    base = {
        "other": _other_info(other),
        "can_message": friends and block is None,
        "blocked": block is not None,
        "blocked_by_me": blocked_by_me,
        "messages": [],
        "has_more": False,
        "seen_up_to": 0,
        "theme": "default",
        "other_typing": False,
        "updated_messages": [],
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
    if not before_id and block is None:
        updated = Message.query.filter(
            Message.conversation_id == conv.id,
            Message.sender_id == other.id,
            Message.read_at.is_(None),
        ).update({"read_at": datetime.utcnow()}, synchronize_session=False)

        if updated:
            db.session.commit()

    base["messages"] = [_message_dict(m) for m in messages]
    base["seen_up_to"] = _seen_up_to(conv.id)
    base["theme"] = _theme_for(conv.id, g.me_id)
    base["other_typing"] = _other_typing(conv.id, other.id) if block is None else False
    if after_id:
        latest = Message.query.filter_by(conversation_id=conv.id).order_by(Message.id.desc()).limit(PAGE_SIZE).all()
        base["updated_messages"] = [_message_dict(m) for m in reversed(latest)]

    return jsonify(base)


@messages_bp.route("/conversations/<username>/messages", methods=["POST"])
@login_required
def send_message(username):
    other = _other_user(username)
    if not other:
        return _error("User not found", 404)
    if _block_between(g.me_id, other.id):
        return _error("Messaging is unavailable because one of you blocked the other", 403)
    if not _are_friends(g.me_id, other.id):
        return _error("You can only message people you are friends with", 403)

    upload_image = upload_audio = None
    sticker = None
    reply_to_id = None
    if (request.content_type or "").startswith("multipart/form-data"):
        text = request.form.get("text") or ""
        upload_image = request.files.get("image")
        upload_audio = request.files.get("audio")
        sticker = request.form.get("sticker") or None
        try:
            reply_to_id = int(request.form["reply_to_id"]) if request.form.get("reply_to_id") else None
        except ValueError:
            return _error("Invalid reply target", 400)
    else:
        payload = request.get_json(silent=True) or {}
        text = payload.get("text") or ""
        sticker = payload.get("sticker") or None
        try:
            reply_to_id = int(payload["reply_to_id"]) if payload.get("reply_to_id") else None
        except (TypeError, ValueError):
            return _error("Invalid reply target", 400)

    if not isinstance(text, str):
        return _error("Message text must be a string", 400)
    text = text.strip()
    if len(text) > MAX_TEXT:
        return _error(f"Messages can be up to {MAX_TEXT} characters", 400)
    if sticker and (not isinstance(sticker, str) or sticker not in ALLOWED_STICKERS):
        return _error("That sticker is not available", 400)
    if sum(bool(x) for x in (upload_image, upload_audio, sticker)) > 1:
        return _error("Send one attachment or sticker at a time", 400)
    if not text and not upload_image and not upload_audio and not sticker:
        return _error("Write a message, record a voice note, choose an image, or send a sticker", 400)

    saved_image = saved_audio = None
    if upload_image:
        data = upload_image.read(MAX_IMAGE_BYTES + 1)
        if len(data) > MAX_IMAGE_BYTES:
            return _error("That image is too large. The limit is 5 MB.", 413)
        kind = detect_image_type(data[:16])
        if not kind:
            return _error("Only JPG, PNG, GIF or WebP images are allowed", 400)
        try:
            data, kind = prepare_image(data, kind)
        except ImageProblem as problem:
            return _error(str(problem), 400)
        saved_image = save_message_image(data, kind)

    if upload_audio:
        data = upload_audio.read(MAX_AUDIO_BYTES + 1)
        if len(data) > MAX_AUDIO_BYTES:
            return _error("That voice note is too large. The limit is 5 MB.", 413)
        kind = detect_audio_type(data[:128])
        if not kind:
            return _error("Unsupported voice-note format. Use WebM, Ogg, WAV, or MP4 audio.", 400)
        saved_audio = save_message_audio(data, kind)

    conv = _find_conversation(g.me_id, other.id)
    if not conv:
        low, high = _pair(g.me_id, other.id)
        conv = Conversation(user_low_id=low, user_high_id=high)
        db.session.add(conv)
        try:
            db.session.commit()
        except IntegrityError:
            db.session.rollback()
            conv = _find_conversation(g.me_id, other.id)

    if reply_to_id:
        target = db.session.get(Message, reply_to_id)
        if not target or target.conversation_id != conv.id:
            if saved_image or saved_audio:
                delete_upload_files([saved_image, saved_audio])
            return _error("The message you are replying to was not found in this chat", 400)

    message_type = "IMAGE" if saved_image else "AUDIO" if saved_audio else "STICKER" if sticker else "TEXT"
    message = Message(
        conversation_id=conv.id, sender_id=g.me_id, message_type=message_type,
        body=text or None, image_filename=saved_image, audio_filename=saved_audio,
        sticker_key=sticker, reply_to_id=reply_to_id,
    )
    db.session.add(message)
    conv.last_message_at = datetime.utcnow()
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        delete_upload_files([saved_image, saved_audio])
        return _error("Message could not be sent. Please try again.", 500)
    return jsonify(_message_dict(message)), 201


@messages_bp.route("/messages/<int:message_id>", methods=["PATCH"])
@login_required
def edit_message(message_id):
    message = db.session.get(Message, message_id)
    if not message or message.sender_id != g.me_id or message.message_type != "TEXT":
        return _error("Message not found or cannot be edited", 404)
    conv = db.session.get(Conversation, message.conversation_id)
    if not conv or g.me_id not in (conv.user_low_id, conv.user_high_id):
        return _error("Message not found", 404)
    other_id = conv.user_high_id if conv.user_low_id == g.me_id else conv.user_low_id
    if _block_between(g.me_id, other_id):
        return _error("Messaging interactions are unavailable because one of you blocked the other", 403)
    payload = request.get_json(silent=True) or {}
    text = payload.get("text")
    if not isinstance(text, str) or not text.strip() or len(text.strip()) > MAX_TEXT:
        return _error("Edited text must contain 1–2000 characters", 400)
    message.body = text.strip()
    message.edited_at = datetime.utcnow()
    db.session.commit()
    return jsonify(_message_dict(message))


@messages_bp.route("/messages/<int:message_id>/reactions", methods=["POST"])
@login_required
def toggle_reaction(message_id):
    message = db.session.get(Message, message_id)
    if not message:
        return _error("Message not found", 404)
    conv = db.session.get(Conversation, message.conversation_id)
    if not conv or g.me_id not in (conv.user_low_id, conv.user_high_id):
        return _error("Message not found", 404)
    other_id = conv.user_high_id if conv.user_low_id == g.me_id else conv.user_low_id
    if _block_between(g.me_id, other_id):
        return _error("Messaging interactions are unavailable because one of you blocked the other", 403)
    emoji = (request.get_json(silent=True) or {}).get("emoji")
    if not isinstance(emoji, str) or emoji not in ALLOWED_REACTIONS:
        return _error("That reaction is not available", 400)
    reaction = MessageReaction.query.filter_by(message_id=message.id, user_id=g.me_id, emoji=emoji).first()
    if reaction:
        db.session.delete(reaction)
    else:
        db.session.add(MessageReaction(message_id=message.id, user_id=g.me_id, emoji=emoji))
    db.session.commit()
    return jsonify(_message_dict(message))


@messages_bp.route("/conversations/<username>/typing", methods=["POST"])
@login_required
def update_typing(username):
    other = _other_user(username)
    if not other or not _are_friends(g.me_id, other.id):
        return _error("Conversation not available", 404)
    if _block_between(g.me_id, other.id):
        return _error("Messaging interactions are unavailable because one of you blocked the other", 403)
    conv = _find_conversation(g.me_id, other.id)
    if not conv:
        return jsonify({"typing": False})
    typing_value = (request.get_json(silent=True) or {}).get("typing", False)
    if not isinstance(typing_value, bool):
        return _error("Typing status must be true or false", 400)
    typing = typing_value
    row = ChatTyping.query.filter_by(conversation_id=conv.id, user_id=g.me_id).first()
    if typing:
        if row:
            row.updated_at = datetime.utcnow()
        else:
            db.session.add(ChatTyping(conversation_id=conv.id, user_id=g.me_id, updated_at=datetime.utcnow()))
    elif row:
        db.session.delete(row)
    db.session.commit()
    return jsonify({"typing": typing})


@messages_bp.route("/conversations/<username>/preferences", methods=["GET", "PUT"])
@login_required
def chat_preferences(username):
    other = _other_user(username)
    if not other or not _are_friends(g.me_id, other.id):
        return _error("Conversation not available", 404)
    if _block_between(g.me_id, other.id):
        return _error("Conversation not available", 404)
    conv = _find_conversation(g.me_id, other.id)
    if not conv:
        return jsonify({"theme": "default"})
    if request.method == "PUT":
        theme = (request.get_json(silent=True) or {}).get("theme")
        if not isinstance(theme, str) or theme not in ALLOWED_THEMES:
            return _error("Unknown chat theme", 400)
        pref = ChatPreference.query.filter_by(conversation_id=conv.id, user_id=g.me_id).first()
        if pref:
            pref.theme = theme
        else:
            db.session.add(ChatPreference(conversation_id=conv.id, user_id=g.me_id, theme=theme))
        db.session.commit()
        return jsonify({"theme": theme})
    return jsonify({"theme": _theme_for(conv.id, g.me_id)})


# --------------------------------------------------------- safety actions

USER_REPORT_REASONS = {"Harassment", "Scams or fraud", "Cheating", "Stake manipulation", "Other"}
MAX_USER_REPORT_DETAILS = 500


@messages_bp.route("/users/<username>/block", methods=["POST"])
@login_required
def block_user(username):
    other = _other_user(username)
    if not other:
        return _error("User not found", 404)
    if UserBlock.query.filter_by(blocker_id=g.me_id, blocked_id=other.id).first():
        return _error("This user is already blocked", 409)

    db.session.add(UserBlock(blocker_id=g.me_id, blocked_id=other.id))
    low, high = _pair(g.me_id, other.id)
    Friendship.query.filter_by(user_low_id=low, user_high_id=high).delete(synchronize_session=False)
    conversation = _find_conversation(g.me_id, other.id)
    if conversation:
        ChatTyping.query.filter_by(conversation_id=conversation.id).delete(synchronize_session=False)
    FriendRequest.query.filter(
        or_(
            ((FriendRequest.sender_id == g.me_id) & (FriendRequest.receiver_id == other.id)),
            ((FriendRequest.sender_id == other.id) & (FriendRequest.receiver_id == g.me_id)),
        )
    ).delete(synchronize_session=False)
    try:
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        return _error("This user is already blocked", 409)
    return jsonify({"message": "User blocked. They can no longer message you.", "blocked": True})


@messages_bp.route("/users/<username>/block", methods=["DELETE"])
@login_required
def unblock_user(username):
    other = _other_user(username)
    if not other:
        return _error("User not found", 404)
    block = UserBlock.query.filter_by(blocker_id=g.me_id, blocked_id=other.id).first()
    if not block:
        return _error("This user is not blocked by you", 404)
    db.session.delete(block)
    db.session.commit()
    return jsonify({"message": "User unblocked. You can message them again if you are friends.", "blocked": False})


@messages_bp.route("/users/<username>/report", methods=["POST"])
@login_required
def report_user(username):
    other = _other_user(username)
    if not other:
        return _error("User not found", 404)
    payload = request.get_json(silent=True) or {}
    reason = payload.get("reason", "")
    details = payload.get("details", "")
    if reason is None: reason = ""
    if details is None: details = ""
    if not isinstance(reason, str) or not isinstance(details, str):
        return _error("Reason and details must be text", 400)
    reason = reason.strip()
    details = details.strip()
    if reason not in USER_REPORT_REASONS:
        return _error("Please choose a valid reason for your report", 400)
    if len(details) > MAX_USER_REPORT_DETAILS:
        return _error(f"Details can be up to {MAX_USER_REPORT_DETAILS} characters", 400)
    duplicate = UserReport.query.filter_by(reporter_id=g.me_id, reported_user_id=other.id, status="open").first()
    if duplicate:
        return _error("You already have an open report for this user. Our team will review it.", 409)
    db.session.add(UserReport(reporter_id=g.me_id, reported_user_id=other.id, reason=reason, details=details or None))
    db.session.commit()
    return jsonify({"message": "Report submitted. Our team will review it."}), 201


# ------------------------------------------------------------------ images

@messages_bp.route("/messages/audio/<filename>")
def message_audio(filename):
    if not AUDIO_NAME.match(filename):
        abort(404)
    viewer = verified_viewer("messages", filename)
    message = Message.query.filter_by(audio_filename=filename).first()
    conv = db.session.get(Conversation, message.conversation_id) if message else None
    if viewer is None or not conv or viewer not in (conv.user_low_id, conv.user_high_id):
        abort(404)
    ext = filename.rsplit(".", 1)[1]
    audio_mime = {"webm": "audio/webm", "ogg": "audio/ogg", "mp4": "audio/mp4", "wav": "audio/wav"}[ext]
    response = send_from_directory(MESSAGE_DIR, filename, mimetype=audio_mime)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Cache-Control"] = "private, no-store"
    return response


@messages_bp.route("/messages/images/<filename>")
def message_image(filename):
    if not SAFE_NAME.match(filename):
        abort(404)

    viewer = verified_viewer("messages", filename)

    if viewer is None:
        abort(404)

    message = Message.query.filter_by(image_filename=filename).first()
    conv = db.session.get(Conversation, message.conversation_id) if message else None

    # Only the two people in the conversation may ever see the image
    if not conv or viewer not in (conv.user_low_id, conv.user_high_id):
        abort(404)

    response = send_from_directory(
        MESSAGE_DIR,
        filename,
        mimetype=MIME[filename.rsplit(".", 1)[1]],
    )
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Cache-Control"] = "private, max-age=86400, immutable"
    return response