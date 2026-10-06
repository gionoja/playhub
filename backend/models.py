from datetime import datetime

from sqlalchemy import CheckConstraint, Index, UniqueConstraint, or_, text

from database import db
from uploads import delete_upload_files


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

    Profile.query.filter_by(user_id=uid).delete(synchronize_session=False)

    db.session.delete(user)