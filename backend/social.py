"""Profiles, user search and the friend system. Every route needs a login token."""
from datetime import datetime

from flask import Blueprint, g, jsonify, request
from sqlalchemy import and_, or_
from sqlalchemy.exc import IntegrityError

from accounts import get_privacy
from auth import login_required
from database import db
from models import FriendRequest, Friendship, Post, Profile, User
from profiles import avatar_url, preload_avatars

social_bp = Blueprint("social", __name__)


# ---------------------------------------------------------------- helpers

def _pair(a, b):
    return (a, b) if a < b else (b, a)


def _pair_key(a, b):
    low, high = _pair(a, b)
    return f"{low}:{high}"


def _iso(dt):
    return dt.isoformat() + "Z" if dt else None


def _ensure_profile(user):
    profile = Profile.query.filter_by(user_id=user.id).first()
    if not profile:
        profile = Profile(user_id=user.id)
        db.session.add(profile)
        db.session.commit()
    return profile


def _friends_count(user_id):
    return Friendship.query.filter(
        or_(Friendship.user_low_id == user_id, Friendship.user_high_id == user_id)
    ).count()


def _relationships(me_id, other_ids):
    """Relationship of me to each other user:
    self | friends | request_sent | request_received | none"""

    result = {oid: {"status": "none", "request_id": None} for oid in other_ids}
    others = [oid for oid in other_ids if oid != me_id]

    if me_id in result:
        result[me_id]["status"] = "self"

    if not others:
        return result

    friendships = Friendship.query.filter(
        or_(
            and_(Friendship.user_low_id == me_id, Friendship.user_high_id.in_(others)),
            and_(Friendship.user_high_id == me_id, Friendship.user_low_id.in_(others)),
        )
    ).all()

    for f in friendships:
        other = f.user_high_id if f.user_low_id == me_id else f.user_low_id
        result[other]["status"] = "friends"

    pending = FriendRequest.query.filter(
        FriendRequest.status == "pending",
        FriendRequest.pair_key.in_([_pair_key(me_id, oid) for oid in others]),
    ).all()

    for r in pending:
        other = r.receiver_id if r.sender_id == me_id else r.sender_id
        if result[other]["status"] == "friends":
            continue
        result[other]["status"] = (
            "request_sent" if r.sender_id == me_id else "request_received"
        )
        result[other]["request_id"] = r.id

    return result


def _person(user, rel):
    return {
        "full_name": user.full_name,
        "username": user.username,
        "avatar_url": avatar_url(user.id),
        "relationship": rel["status"],
        "request_id": rel["request_id"],
    }


def _friend_id_set(user_id):
    rows = Friendship.query.filter(
        or_(Friendship.user_low_id == user_id, Friendship.user_high_id == user_id)
    ).all()

    return {
        f.user_high_id if f.user_low_id == user_id else f.user_low_id for f in rows
    }


def _like(text):
    escaped = text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _error(message, status):
    return jsonify({"message": message}), status


# --------------------------------------------------------------- profiles

@social_bp.route("/me")
@login_required
def me():
    user = g.user
    profile = _ensure_profile(user)

    incoming = FriendRequest.query.filter_by(
        receiver_id=user.id, status="pending"
    ).count()

    return jsonify({
        "full_name": user.full_name,
        "username": user.username,
        "email": user.email,
        "bio": profile.bio,
        "avatar_url": avatar_url(user.id),
        "friends_count": _friends_count(user.id),
        "posts_count": Post.query.filter_by(user_id=user.id).count(),
        "pending_requests": incoming,
    })


@social_bp.route("/users/search")
@login_required
def search_users():
    q = (request.args.get("q") or "").strip().lstrip("@")

    if len(q) < 2:
        return _error("Type at least 2 characters to search", 400)

    pattern = _like(q)

    users = (
        User.query.filter(
            User.email_verified.is_(True),
            User.id != g.me_id,
            or_(
                User.username.ilike(pattern, escape="\\"),
                User.full_name.ilike(pattern, escape="\\"),
            ),
        )
        .order_by(User.username)
        .limit(20)
        .all()
    )

    preload_avatars([u.id for u in users])
    rels = _relationships(g.me_id, [u.id for u in users])

    return jsonify([_person(u, rels[u.id]) for u in users])


@social_bp.route("/users/suggestions")
@login_required
def suggestions():
    """Verified people you aren't friends with yet, newest accounts first."""
    users = (
        User.query.filter(User.email_verified.is_(True), User.id != g.me_id)
        .order_by(User.id.desc())
        .limit(40)
        .all()
    )

    preload_avatars([u.id for u in users])
    rels = _relationships(g.me_id, [u.id for u in users])

    people = [
        _person(u, rels[u.id]) for u in users if rels[u.id]["status"] != "friends"
    ]

    return jsonify(people[:20])


@social_bp.route("/users/<username>")
@login_required
def public_profile(username):
    user = User.query.filter_by(username=username).first()

    # Unverified accounts are not visible to anyone else
    if not user or (not user.email_verified and user.id != g.me_id):
        return _error("User not found", 404)

    profile = _ensure_profile(user)
    rel = _relationships(g.me_id, [user.id])[user.id]
    settings = get_privacy(user.id)

    is_self = user.id == g.me_id
    is_friend = rel["status"] == "friends"

    def allowed(level):
        return is_self or level == "everyone" or (level == "friends" and is_friend)

    data = None

    friend_ids = _friend_id_set(user.id)
    friends_visible = allowed(settings["friends_visibility"])
    info_visible = allowed(settings["info_visibility"])
    email_visible = allowed(settings["email_visibility"])
    posts_visible = is_self or is_friend

    friends, mutual = [], []

    if friends_visible:
        recent = Friendship.query.filter(
            or_(Friendship.user_low_id == user.id, Friendship.user_high_id == user.id)
        ).order_by(Friendship.created_at.desc()).limit(12).all()

        ids = [
            f.user_high_id if f.user_low_id == user.id else f.user_low_id
            for f in recent
        ]

        mutual_ids = []
        if not is_self:
            mutual_ids = list(friend_ids & _friend_id_set(g.me_id))[:6]

        people = {
            u.id: u for u in User.query.filter(User.id.in_(set(ids) | set(mutual_ids))).all()
        } if (ids or mutual_ids) else {}

        preload_avatars(list(people) + [user.id])

        def brief(uid):
            u = people[uid]
            return {
                "full_name": u.full_name,
                "username": u.username,
                "avatar_url": avatar_url(u.id),
            }

        friends = [brief(i) for i in ids if i in people]
        mutual = [brief(i) for i in mutual_ids if i in people]

    preload_avatars([user.id])

    data = _person(user, rel)
    data.update({
        "bio": profile.bio if info_visible else "",
        "joined": _iso(profile.created_at) if info_visible else None,
        "info_hidden": not info_visible,
        "email": user.email if email_visible else None,
        "email_hidden": not email_visible,
        "friends_hidden": not friends_visible,
        "friends_count": len(friend_ids) if friends_visible else None,
        "friends": friends,
        "mutual_friends": mutual,
        "mutual_count": len(friend_ids & _friend_id_set(g.me_id)) if (friends_visible and not is_self) else 0,
        "posts_count": Post.query.filter_by(user_id=user.id).count() if posts_visible else None,
        # Real numbers. They stay at zero until matches exist.
        "stats": {"games_played": 0, "wins": 0},
    })

    return jsonify(data)


# ---------------------------------------------------------- friend system

@social_bp.route("/friends")
@login_required
def list_friends():
    rows = Friendship.query.filter(
        or_(
            Friendship.user_low_id == g.me_id,
            Friendship.user_high_id == g.me_id,
        )
    ).all()

    ids = [
        f.user_high_id if f.user_low_id == g.me_id else f.user_low_id
        for f in rows
    ]

    users = User.query.filter(User.id.in_(ids)).order_by(User.full_name).all() if ids else []

    preload_avatars([u.id for u in users])

    rel = {"status": "friends", "request_id": None}
    return jsonify([_person(u, rel) for u in users])


@social_bp.route("/friends/requests")
@login_required
def list_requests():
    pending = FriendRequest.query.filter(
        FriendRequest.status == "pending",
        or_(
            FriendRequest.sender_id == g.me_id,
            FriendRequest.receiver_id == g.me_id,
        ),
    ).order_by(FriendRequest.created_at.desc()).all()

    preload_avatars(
        [r.sender_id for r in pending] + [r.receiver_id for r in pending]
    )

    incoming, outgoing = [], []

    for r in pending:
        if r.receiver_id == g.me_id:
            incoming.append({
                "request_id": r.id,
                "full_name": r.sender.full_name,
                "username": r.sender.username,
                "avatar_url": avatar_url(r.sender_id),
                "relationship": "request_received",
                "created_at": _iso(r.created_at),
            })
        else:
            outgoing.append({
                "request_id": r.id,
                "full_name": r.receiver.full_name,
                "username": r.receiver.username,
                "avatar_url": avatar_url(r.receiver_id),
                "relationship": "request_sent",
                "created_at": _iso(r.created_at),
            })

    return jsonify({"incoming": incoming, "outgoing": outgoing})


@social_bp.route("/friends/requests", methods=["POST"])
@login_required
def send_request():
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip()

    target = User.query.filter_by(username=username).first()

    if not target or not target.email_verified:
        return _error("User not found", 404)

    if target.id == g.me_id:
        return _error("You can't add yourself as a friend", 400)

    rel = _relationships(g.me_id, [target.id])[target.id]

    if rel["status"] == "friends":
        return _error("You are already friends", 409)

    if rel["status"] == "request_sent":
        return _error("Friend request already sent", 409)

    if rel["status"] == "request_received":
        return _error(
            "This person already sent you a request. Accept it instead.", 409
        )

    fr = FriendRequest(
        sender_id=g.me_id,
        receiver_id=target.id,
        pair_key=_pair_key(g.me_id, target.id),
        status="pending",
    )
    db.session.add(fr)

    try:
        db.session.commit()
    except IntegrityError:
        # Someone else's request landed first
        db.session.rollback()
        return _error("A request between you already exists", 409)

    return jsonify({"message": "Friend request sent", "request_id": fr.id}), 201


def _load_request(request_id):
    """Only the two people involved may even see that a request exists."""
    fr = db.session.get(FriendRequest, request_id)

    if not fr or g.me_id not in (fr.sender_id, fr.receiver_id):
        return None

    return fr


@social_bp.route("/friends/requests/<int:request_id>/accept", methods=["POST"])
@login_required
def accept_request(request_id):
    fr = _load_request(request_id)

    if not fr:
        return _error("Request not found", 404)

    if fr.receiver_id != g.me_id:
        return _error("Only the person who received the request can accept it", 403)

    if fr.status != "pending":
        return _error("This request has already been handled", 409)

    low, high = _pair(fr.sender_id, fr.receiver_id)

    fr.status = "accepted"
    fr.responded_at = datetime.utcnow()
    db.session.add(Friendship(user_low_id=low, user_high_id=high))

    try:
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        return _error("This request has already been handled", 409)

    return jsonify({"message": "Friend request accepted"})


@social_bp.route("/friends/requests/<int:request_id>/reject", methods=["POST"])
@login_required
def reject_request(request_id):
    fr = _load_request(request_id)

    if not fr:
        return _error("Request not found", 404)

    if fr.receiver_id != g.me_id:
        return _error("Only the person who received the request can reject it", 403)

    if fr.status != "pending":
        return _error("This request has already been handled", 409)

    fr.status = "rejected"
    fr.responded_at = datetime.utcnow()
    db.session.commit()

    return jsonify({"message": "Friend request rejected"})


@social_bp.route("/friends/requests/<int:request_id>/cancel", methods=["POST"])
@login_required
def cancel_request(request_id):
    fr = _load_request(request_id)

    if not fr:
        return _error("Request not found", 404)

    if fr.sender_id != g.me_id:
        return _error("Only the person who sent the request can cancel it", 403)

    if fr.status != "pending":
        return _error("This request has already been handled", 409)

    fr.status = "cancelled"
    fr.responded_at = datetime.utcnow()
    db.session.commit()

    return jsonify({"message": "Friend request cancelled"})


@social_bp.route("/friends/<username>", methods=["DELETE"])
@login_required
def remove_friend(username):
    other = User.query.filter_by(username=username).first()

    if not other:
        return _error("User not found", 404)

    low, high = _pair(g.me_id, other.id)

    friendship = Friendship.query.filter_by(
        user_low_id=low, user_high_id=high
    ).first()

    if not friendship:
        return _error("You are not friends with this person", 404)

    db.session.delete(friendship)
    db.session.commit()

    return jsonify({"message": "Friend removed"})