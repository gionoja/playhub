from datetime import datetime

from sqlalchemy import CheckConstraint, Index, UniqueConstraint, or_, text

from database import db
from uploads import POST_DIR, STORY_DIR, delete_upload_files


class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)

    full_name = db.Column(db.String(100), nullable=False)

    username = db.Column(
        db.String(50),
        unique=True,
        nullable=False
    )

    email = db.Column(
        db.String(120),
        unique=True,
        nullable=False
    )

    password_hash = db.Column(
        db.String(255),
        nullable=False
    )

    email_verified = db.Column(
        db.Boolean,
        default=False
    )

    verification_token = db.Column(
        db.String(255),
        nullable=True
    )

    verification_token_expires = db.Column(
        db.DateTime,
        nullable=True
    )


class Profile(db.Model):
    """One public profile per account. Created automatically at signup."""

    id = db.Column(db.Integer, primary_key=True)

    user_id = db.Column(
        db.Integer,
        db.ForeignKey("user.id"),
        unique=True,
        nullable=False
    )

    bio = db.Column(db.String(160), nullable=False, default="")

    # Reserved for profile photo uploads (added together with image uploads)
    avatar_filename = db.Column(db.String(255), nullable=True)

    # Reserved for online/offline status in messaging
    last_seen = db.Column(db.DateTime, nullable=True)

    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    user = db.relationship(
        "User",
        backref=db.backref("profile", uselist=False)
    )


class FriendRequest(db.Model):
    """
    status: pending | accepted | rejected | cancelled

    Only one *pending* request can exist between two people, in either
    direction. The database enforces that with a partial unique index on
    pair_key, so two simultaneous requests cannot both succeed.
    """

    id = db.Column(db.Integer, primary_key=True)

    sender_id = db.Column(
        db.Integer, db.ForeignKey("user.id"), nullable=False, index=True
    )
    receiver_id = db.Column(
        db.Integer, db.ForeignKey("user.id"), nullable=False, index=True
    )

    # "<smaller user id>:<larger user id>"
    pair_key = db.Column(db.String(32), nullable=False)

    status = db.Column(db.String(12), nullable=False, default="pending")

    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    responded_at = db.Column(db.DateTime, nullable=True)

    sender = db.relationship("User", foreign_keys=[sender_id])
    receiver = db.relationship("User", foreign_keys=[receiver_id])

    __table_args__ = (
        CheckConstraint("sender_id != receiver_id", name="ck_friend_request_not_self"),
        Index(
            "uq_friend_request_pending_pair",
            "pair_key",
            unique=True,
            sqlite_where=text("status = 'pending'"),
        ),
    )


class Friendship(db.Model):
    """A confirmed friendship, stored once with the smaller user id first."""

    id = db.Column(db.Integer, primary_key=True)

    user_low_id = db.Column(
        db.Integer, db.ForeignKey("user.id"), nullable=False, index=True
    )
    user_high_id = db.Column(
        db.Integer, db.ForeignKey("user.id"), nullable=False, index=True
    )

    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("user_low_id", "user_high_id", name="uq_friendship_pair"),
        CheckConstraint("user_low_id < user_high_id", name="ck_friendship_order"),
    )


class Conversation(db.Model):
    """A private chat between two users, stored once (smaller user id first).
    It is created when the first message is sent."""

    id = db.Column(db.Integer, primary_key=True)

    user_low_id = db.Column(
        db.Integer, db.ForeignKey("user.id"), nullable=False, index=True
    )
    user_high_id = db.Column(
        db.Integer, db.ForeignKey("user.id"), nullable=False, index=True
    )

    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    last_message_at = db.Column(db.DateTime, default=datetime.utcnow, index=True)

    __table_args__ = (
        UniqueConstraint("user_low_id", "user_high_id", name="uq_conversation_pair"),
        CheckConstraint("user_low_id < user_high_id", name="ck_conversation_order"),
    )


class Message(db.Model):
    """
    message_type: TEXT | IMAGE | GAME_CHALLENGE | GAME_RESULT | SYSTEM
    Images are stored as files; only the generated file name lives here.
    """

    id = db.Column(db.Integer, primary_key=True)

    conversation_id = db.Column(
        db.Integer, db.ForeignKey("conversation.id"), nullable=False, index=True
    )
    sender_id = db.Column(
        db.Integer, db.ForeignKey("user.id"), nullable=False
    )

    message_type = db.Column(db.String(20), nullable=False, default="TEXT")

    body = db.Column(db.String(2000), nullable=True)
    image_filename = db.Column(db.String(64), nullable=True, index=True)

    # Reserved for game challenge cards (added with game challenges)
    game_challenge_id = db.Column(db.Integer, nullable=True)

    created_at = db.Column(db.DateTime, default=datetime.utcnow, index=True)
    read_at = db.Column(db.DateTime, nullable=True)


class Post(db.Model):
    """A feed post. Visible to its author and the author's friends."""

    id = db.Column(db.Integer, primary_key=True)

    user_id = db.Column(
        db.Integer, db.ForeignKey("user.id"), nullable=False, index=True
    )

    content = db.Column(db.String(2000), nullable=True)
    image_filename = db.Column(db.String(64), nullable=True, index=True)

    created_at = db.Column(db.DateTime, default=datetime.utcnow, index=True)

    author = db.relationship("User", foreign_keys=[user_id])


class PostLike(db.Model):
    """One row per (user, post). The unique pair makes duplicate likes impossible."""

    id = db.Column(db.Integer, primary_key=True)

    post_id = db.Column(
        db.Integer, db.ForeignKey("post.id"), nullable=False, index=True
    )
    user_id = db.Column(
        db.Integer, db.ForeignKey("user.id"), nullable=False
    )

    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("post_id", "user_id", name="uq_post_like_pair"),
    )


class PostComment(db.Model):
    id = db.Column(db.Integer, primary_key=True)

    post_id = db.Column(
        db.Integer, db.ForeignKey("post.id"), nullable=False, index=True
    )
    user_id = db.Column(
        db.Integer, db.ForeignKey("user.id"), nullable=False
    )

    content = db.Column(db.String(500), nullable=False)

    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    author = db.relationship("User", foreign_keys=[user_id])


class Story(db.Model):
    """Active while expires_at is in the future. Rows are kept as history."""

    id = db.Column(db.Integer, primary_key=True)

    user_id = db.Column(
        db.Integer, db.ForeignKey("user.id"), nullable=False, index=True
    )

    image_filename = db.Column(db.String(64), nullable=False, index=True)
    caption = db.Column(db.String(200), nullable=True)

    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    expires_at = db.Column(db.DateTime, nullable=False, index=True)


class StoryView(db.Model):
    id = db.Column(db.Integer, primary_key=True)

    story_id = db.Column(
        db.Integer, db.ForeignKey("story.id"), nullable=False, index=True
    )
    viewer_id = db.Column(
        db.Integer, db.ForeignKey("user.id"), nullable=False
    )

    viewed_at = db.Column(db.DateTime, default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("story_id", "viewer_id", name="uq_story_view_pair"),
    )


class Notification(db.Model):
    """Activity on your posts. kind: post_like | post_comment"""

    id = db.Column(db.Integer, primary_key=True)

    user_id = db.Column(
        db.Integer, db.ForeignKey("user.id"), nullable=False, index=True
    )
    actor_id = db.Column(
        db.Integer, db.ForeignKey("user.id"), nullable=False
    )

    kind = db.Column(db.String(20), nullable=False)
    post_id = db.Column(db.Integer, nullable=True)

    created_at = db.Column(db.DateTime, default=datetime.utcnow, index=True)
    read_at = db.Column(db.DateTime, nullable=True)

    actor = db.relationship("User", foreign_keys=[actor_id])


def delete_user_completely(user):
    """Delete a user together with everything that points at them.
    The caller commits."""

    uid = user.id

    FriendRequest.query.filter(
        or_(FriendRequest.sender_id == uid, FriendRequest.receiver_id == uid)
    ).delete(synchronize_session=False)

    Friendship.query.filter(
        or_(Friendship.user_low_id == uid, Friendship.user_high_id == uid)
    ).delete(synchronize_session=False)

    conversation_ids = [
        c.id for c in Conversation.query.filter(
            or_(Conversation.user_low_id == uid, Conversation.user_high_id == uid)
        ).all()
    ]

    if conversation_ids:
        files = [
            m.image_filename for m in Message.query.filter(
                Message.conversation_id.in_(conversation_ids),
                Message.image_filename.isnot(None),
            ).all()
        ]
        Message.query.filter(
            Message.conversation_id.in_(conversation_ids)
        ).delete(synchronize_session=False)
        Conversation.query.filter(
            Conversation.id.in_(conversation_ids)
        ).delete(synchronize_session=False)
        delete_upload_files(files)

    # Their posts (with the likes, comments and images on them)
    posts = Post.query.filter_by(user_id=uid).all()
    post_ids = [p.id for p in posts]

    if post_ids:
        PostLike.query.filter(PostLike.post_id.in_(post_ids)).delete(synchronize_session=False)
        PostComment.query.filter(PostComment.post_id.in_(post_ids)).delete(synchronize_session=False)
        Notification.query.filter(Notification.post_id.in_(post_ids)).delete(synchronize_session=False)
        Post.query.filter(Post.id.in_(post_ids)).delete(synchronize_session=False)
        delete_upload_files([p.image_filename for p in posts], POST_DIR)

    # Their likes, comments and notifications on other people's posts
    PostLike.query.filter_by(user_id=uid).delete(synchronize_session=False)
    PostComment.query.filter_by(user_id=uid).delete(synchronize_session=False)
    Notification.query.filter(
        or_(Notification.user_id == uid, Notification.actor_id == uid)
    ).delete(synchronize_session=False)

    # Their stories and story views
    stories = Story.query.filter_by(user_id=uid).all()
    story_ids = [s.id for s in stories]

    if story_ids:
        StoryView.query.filter(StoryView.story_id.in_(story_ids)).delete(synchronize_session=False)
        Story.query.filter(Story.id.in_(story_ids)).delete(synchronize_session=False)
        delete_upload_files([s.image_filename for s in stories], STORY_DIR)

    StoryView.query.filter_by(viewer_id=uid).delete(synchronize_session=False)

    Profile.query.filter_by(user_id=uid).delete(synchronize_session=False)

    db.session.delete(user)