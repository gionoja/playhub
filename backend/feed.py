"""Posts, likes, comments, stories and activity notifications.

Visibility rule used everywhere: you can see your own content and the content
of your friends. The server enforces it; the browser is never trusted."""
from datetime import datetime, timedelta

from flask import Blueprint, abort, current_app, g, jsonify, request, send_from_directory
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from sqlalchemy import func, or_
from sqlalchemy.exc import IntegrityError

from auth import login_required
from database import db
from models import (
    Friendship, Notification, Post, PostComment, PostLike, Story, StoryView, User
)
from uploads import (
    MAX_IMAGE_BYTES, MIME, POST_DIR, SAFE_NAME, STORY_DIR, delete_upload_files,
    detect_image_type, save_image
)

feed_bp = Blueprint("feed", __name__)

MAX_POST_TEXT = 2000
MAX_COMMENT = 500
MAX_CAPTION = 200
FEED_PAGE = 20
PROFILE_PAGE = 10
STORY_LIFETIME = timedelta(hours=24)


# ---------------------------------------------------------------- helpers

def _error(message, status):
    return jsonify({"message": message}), status


def _iso(dt):
    return dt.isoformat() + "Z" if dt else None


def _friend_ids(user_id):
    rows = Friendship.query.filter(
        or_(Friendship.user_low_id == user_id, Friendship.user_high_id == user_id)
    ).all()
    return {
        f.user_high_id if f.user_low_id == user_id else f.user_low_id for f in rows
    }


def _can_see(owner_id, viewer_id=None):
    viewer_id = viewer_id or g.me_id

    if owner_id == viewer_id:
        return True

    low, high = (owner_id, viewer_id) if owner_id < viewer_id else (viewer_id, owner_id)

    return Friendship.query.filter_by(
        user_low_id=low, user_high_id=high
    ).first() is not None


def _signer(kind):
    return URLSafeTimedSerializer(
        current_app.config["SECRET_KEY"], salt=f"playhub-{kind}-image"
    )


def _image_url(kind, filename):
    # <img> tags cannot send a login header, so the link carries a signed,
    # expiring pass tied to this user and this file.
    token = _signer(kind).dumps({"f": filename, "u": g.me_id})
    return f"/{kind}/images/{filename}?t={token}"


def _person(user):
    return {"full_name": user.full_name, "username": user.username}


def _read_upload():
    """Validate an uploaded image. Returns (data, ext, None) or (None, None, error response)."""
    upload = request.files.get("image")

    if not upload:
        return None, None, None

    data = upload.read(MAX_IMAGE_BYTES + 1)

    if len(data) > MAX_IMAGE_BYTES:
        return None, None, _error("That image is too large. The limit is 5 MB.", 413)

    ext = detect_image_type(data[:16])

    if not ext:
        return None, None, _error("Only JPG, PNG, GIF or WebP images are allowed", 400)

    return data, ext, None


def _notify(recipient_id, kind, post_id):
    if recipient_id == g.me_id:
        return

    if kind == "post_like":
        already = Notification.query.filter_by(
            user_id=recipient_id, actor_id=g.me_id, kind=kind,
            post_id=post_id, read_at=None
        ).first()

        if already:
            return

    db.session.add(Notification(
        user_id=recipient_id, actor_id=g.me_id, kind=kind, post_id=post_id
    ))


def _serialize_posts(posts):
    """Everything the feed needs in a handful of queries, not one per post."""
    if not posts:
        return []

    ids = [p.id for p in posts]

    likes = dict(
        db.session.query(PostLike.post_id, func.count(PostLike.id))
        .filter(PostLike.post_id.in_(ids)).group_by(PostLike.post_id).all()
    )
    comments = dict(
        db.session.query(PostComment.post_id, func.count(PostComment.id))
        .filter(PostComment.post_id.in_(ids)).group_by(PostComment.post_id).all()
    )
    liked = {
        row[0] for row in db.session.query(PostLike.post_id)
        .filter(PostLike.post_id.in_(ids), PostLike.user_id == g.me_id).all()
    }
    authors = {
        u.id: u for u in User.query.filter(
            User.id.in_({p.user_id for p in posts})
        ).all()
    }

    return [
        {
            "id": p.id,
            "author": _person(authors[p.user_id]),
            "mine": p.user_id == g.me_id,
            "content": p.content or "",
            "image_url": _image_url("posts", p.image_filename) if p.image_filename else None,
            "created_at": _iso(p.created_at),
            "like_count": likes.get(p.id, 0),
            "liked": p.id in liked,
            "comment_count": comments.get(p.id, 0),
        }
        for p in posts if p.user_id in authors
    ]


def _page(query, limit):
    before_id = request.args.get("before_id", type=int)

    if before_id:
        query = query.filter(Post.id < before_id)

    rows = query.order_by(Post.id.desc()).limit(limit + 1).all()

    return rows[:limit], len(rows) > limit


def _visible_post_or_404(post_id):
    post = db.session.get(Post, post_id)

    if not post or not _can_see(post.user_id):
        return None

    return post


# ------------------------------------------------------------------ posts

@feed_bp.route("/feed")
@login_required
def get_feed():
    author_ids = _friend_ids(g.me_id) | {g.me_id}

    posts, has_more = _page(Post.query.filter(Post.user_id.in_(author_ids)), FEED_PAGE)

    return jsonify({"posts": _serialize_posts(posts), "has_more": has_more})


@feed_bp.route("/users/<username>/posts")
@login_required
def user_posts(username):
    user = User.query.filter_by(username=username).first()

    if not user or not user.email_verified:
        return _error("User not found", 404)

    if not _can_see(user.id):
        return jsonify({"posts": [], "has_more": False, "restricted": True})

    posts, has_more = _page(Post.query.filter_by(user_id=user.id), PROFILE_PAGE)

    return jsonify({
        "posts": _serialize_posts(posts), "has_more": has_more, "restricted": False
    })


@feed_bp.route("/posts", methods=["POST"])
@login_required
def create_post():
    if (request.content_type or "").startswith("multipart/form-data"):
        text = request.form.get("text") or ""
    else:
        text = (request.get_json(silent=True) or {}).get("text") or ""

    text = text.strip()

    if len(text) > MAX_POST_TEXT:
        return _error(f"Posts can be up to {MAX_POST_TEXT} characters", 400)

    data, ext, problem = _read_upload()

    if problem:
        return problem

    if not text and not data:
        return _error("Write something or add a photo", 400)

    filename = save_image(data, ext, POST_DIR) if data else None

    post = Post(user_id=g.me_id, content=text or None, image_filename=filename)
    db.session.add(post)

    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        delete_upload_files([filename], POST_DIR)
        return _error("Your post could not be published. Please try again.", 500)

    return jsonify(_serialize_posts([post])[0]), 201


@feed_bp.route("/posts/<int:post_id>", methods=["DELETE"])
@login_required
def delete_post(post_id):
    post = db.session.get(Post, post_id)

    if not post or post.user_id != g.me_id:
        return _error("Post not found", 404)

    PostLike.query.filter_by(post_id=post_id).delete(synchronize_session=False)
    PostComment.query.filter_by(post_id=post_id).delete(synchronize_session=False)
    Notification.query.filter_by(post_id=post_id).delete(synchronize_session=False)
    filename = post.image_filename
    db.session.delete(post)
    db.session.commit()

    delete_upload_files([filename], POST_DIR)

    return jsonify({"message": "Post deleted"})


@feed_bp.route("/posts/images/<filename>")
def post_image(filename):
    return _serve_image("posts", filename, POST_DIR)


# ------------------------------------------------------------------ likes

def _like_state(post_id, liked):
    count = PostLike.query.filter_by(post_id=post_id).count()
    return jsonify({"liked": liked, "like_count": count})


@feed_bp.route("/posts/<int:post_id>/like", methods=["POST"])
@login_required
def like_post(post_id):
    post = _visible_post_or_404(post_id)

    if not post:
        return _error("Post not found", 404)

    db.session.add(PostLike(post_id=post_id, user_id=g.me_id))

    try:
        _notify(post.user_id, "post_like", post_id)
        db.session.commit()
    except IntegrityError:
        db.session.rollback()          # already liked: nothing to do

    return _like_state(post_id, True)


@feed_bp.route("/posts/<int:post_id>/like", methods=["DELETE"])
@login_required
def unlike_post(post_id):
    post = _visible_post_or_404(post_id)

    if not post:
        return _error("Post not found", 404)

    PostLike.query.filter_by(post_id=post_id, user_id=g.me_id).delete(
        synchronize_session=False
    )
    db.session.commit()

    return _like_state(post_id, False)


# --------------------------------------------------------------- comments

def _comment_dict(c):
    return {
        "id": c.id,
        "author": _person(c.author),
        "mine": c.user_id == g.me_id,
        "text": c.content,
        "created_at": _iso(c.created_at),
    }


def _comment_count(post_id):
    return PostComment.query.filter_by(post_id=post_id).count()


@feed_bp.route("/posts/<int:post_id>/comments")
@login_required
def get_comments(post_id):
    if not _visible_post_or_404(post_id):
        return _error("Post not found", 404)

    comments = PostComment.query.filter_by(post_id=post_id).order_by(
        PostComment.id.asc()
    ).limit(200).all()

    return jsonify({
        "comments": [_comment_dict(c) for c in comments],
        "comment_count": _comment_count(post_id),
    })


@feed_bp.route("/posts/<int:post_id>/comments", methods=["POST"])
@login_required
def add_comment(post_id):
    post = _visible_post_or_404(post_id)

    if not post:
        return _error("Post not found", 404)

    text = ((request.get_json(silent=True) or {}).get("text") or "").strip()

    if not text:
        return _error("Write a comment first", 400)

    if len(text) > MAX_COMMENT:
        return _error(f"Comments can be up to {MAX_COMMENT} characters", 400)

    comment = PostComment(post_id=post_id, user_id=g.me_id, content=text)
    db.session.add(comment)
    _notify(post.user_id, "post_comment", post_id)
    db.session.commit()

    return jsonify({
        "comment": _comment_dict(comment),
        "comment_count": _comment_count(post_id),
    }), 201


@feed_bp.route("/comments/<int:comment_id>", methods=["DELETE"])
@login_required
def delete_comment(comment_id):
    comment = db.session.get(PostComment, comment_id)

    if not comment or comment.user_id != g.me_id:
        return _error("Comment not found", 404)

    post_id = comment.post_id
    db.session.delete(comment)
    db.session.commit()

    return jsonify({"comment_count": _comment_count(post_id)})


# ---------------------------------------------------------------- stories

@feed_bp.route("/stories", methods=["POST"])
@login_required
def create_story():
    data, ext, problem = _read_upload()

    if problem:
        return problem

    if not data:
        return _error("Choose a photo for your story", 400)

    caption = (request.form.get("caption") or "").strip()

    if len(caption) > MAX_CAPTION:
        return _error(f"Captions can be up to {MAX_CAPTION} characters", 400)

    filename = save_image(data, ext, STORY_DIR)
    now = datetime.utcnow()

    story = Story(
        user_id=g.me_id, image_filename=filename, caption=caption or None,
        created_at=now, expires_at=now + STORY_LIFETIME
    )
    db.session.add(story)

    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        delete_upload_files([filename], STORY_DIR)
        return _error("Your story could not be published. Please try again.", 500)

    return jsonify({"message": "Story published", "id": story.id}), 201


@feed_bp.route("/stories")
@login_required
def get_stories():
    """Active stories from you and your friends, grouped by person."""
    now = datetime.utcnow()
    owner_ids = _friend_ids(g.me_id) | {g.me_id}

    stories = Story.query.filter(
        Story.user_id.in_(owner_ids), Story.expires_at > now
    ).order_by(Story.created_at.asc()).all()

    if not stories:
        return jsonify([])

    ids = [s.id for s in stories]

    viewed = {
        row[0] for row in db.session.query(StoryView.story_id)
        .filter(StoryView.story_id.in_(ids), StoryView.viewer_id == g.me_id).all()
    }
    view_counts = dict(
        db.session.query(StoryView.story_id, func.count(StoryView.id))
        .filter(StoryView.story_id.in_(ids)).group_by(StoryView.story_id).all()
    )
    users = {u.id: u for u in User.query.filter(User.id.in_(owner_ids)).all()}

    groups = {}

    for s in stories:
        owner = users.get(s.user_id)
        if not owner:
            continue

        mine = s.user_id == g.me_id
        group = groups.setdefault(s.user_id, {
            "user": _person(owner), "is_me": mine, "stories": [], "latest": s.created_at
        })

        item = {
            "id": s.id,
            "image_url": _image_url("stories", s.image_filename),
            "caption": s.caption or "",
            "created_at": _iso(s.created_at),
            "expires_at": _iso(s.expires_at),
            "viewed": mine or s.id in viewed,
        }
        if mine:
            item["view_count"] = view_counts.get(s.id, 0)

        group["stories"].append(item)
        group["latest"] = max(group["latest"], s.created_at)

    result = []

    for group in groups.values():
        group["all_viewed"] = all(i["viewed"] for i in group["stories"])
        group["latest"] = _iso(group["latest"])
        result.append(group)

    # you first, then people with new stories, then the rest, newest first
    result.sort(key=lambda gr: gr["latest"], reverse=True)
    result.sort(key=lambda gr: (not gr["is_me"], gr["all_viewed"]))

    return jsonify(result)


def _active_visible_story(story_id):
    story = db.session.get(Story, story_id)

    if not story or story.expires_at <= datetime.utcnow() or not _can_see(story.user_id):
        return None

    return story


@feed_bp.route("/stories/<int:story_id>/view", methods=["POST"])
@login_required
def view_story(story_id):
    story = _active_visible_story(story_id)

    if not story:
        return _error("This story is no longer available", 404)

    if story.user_id != g.me_id:
        db.session.add(StoryView(story_id=story_id, viewer_id=g.me_id))

        try:
            db.session.commit()
        except IntegrityError:
            db.session.rollback()       # already counted

    return jsonify({"viewed": True})


@feed_bp.route("/stories/<int:story_id>", methods=["DELETE"])
@login_required
def delete_story(story_id):
    story = db.session.get(Story, story_id)

    if not story or story.user_id != g.me_id:
        return _error("Story not found", 404)

    StoryView.query.filter_by(story_id=story_id).delete(synchronize_session=False)
    filename = story.image_filename
    db.session.delete(story)
    db.session.commit()

    delete_upload_files([filename], STORY_DIR)

    return jsonify({"message": "Story deleted"})


@feed_bp.route("/stories/images/<filename>")
def story_image(filename):
    return _serve_image("stories", filename, STORY_DIR)


# ----------------------------------------------------------- image serving

def _serve_image(kind, filename, folder):
    if not SAFE_NAME.match(filename):
        abort(404)

    try:
        payload = _signer(kind).loads(request.args.get("t", ""), max_age=60 * 60 * 24)
    except (BadSignature, SignatureExpired):
        abort(404)

    if payload.get("f") != filename:
        abort(404)

    viewer = payload.get("u")

    if kind == "posts":
        item = Post.query.filter_by(image_filename=filename).first()
    else:
        item = Story.query.filter_by(image_filename=filename).first()

    if not item or not _can_see(item.user_id, viewer):
        abort(404)

    if kind == "stories" and item.expires_at <= datetime.utcnow() and item.user_id != viewer:
        abort(404)

    response = send_from_directory(
        folder, filename, mimetype=MIME[filename.rsplit(".", 1)[1]]
    )
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Cache-Control"] = "private, max-age=3600"
    return response


# ---------------------------------------------------------- notifications

@feed_bp.route("/notifications")
@login_required
def get_notifications():
    rows = Notification.query.filter_by(user_id=g.me_id).order_by(
        Notification.id.desc()
    ).limit(30).all()

    unread = Notification.query.filter_by(user_id=g.me_id, read_at=None).count()

    return jsonify({
        "unread": unread,
        "items": [
            {
                "id": n.id,
                "kind": n.kind,
                "post_id": n.post_id,
                "actor": _person(n.actor),
                "created_at": _iso(n.created_at),
                "read": n.read_at is not None,
            }
            for n in rows
        ],
    })


@feed_bp.route("/notifications/read", methods=["POST"])
@login_required
def mark_notifications_read():
    Notification.query.filter_by(user_id=g.me_id, read_at=None).update(
        {"read_at": datetime.utcnow()}, synchronize_session=False
    )
    db.session.commit()

    return jsonify({"unread": 0})