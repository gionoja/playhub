from datetime import datetime

from sqlalchemy import CheckConstraint, Index, UniqueConstraint, or_, text

from database import db
from uploads import AVATAR_DIR, POST_DIR, STORY_DIR, delete_upload_files


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
    message_type: TEXT | IMAGE | AUDIO | STICKER | GAME_CHALLENGE | GAME_RESULT | SYSTEM
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
    audio_filename = db.Column(db.String(64), nullable=True, index=True)
    sticker_key = db.Column(db.String(32), nullable=True)
    reply_to_id = db.Column(db.Integer, nullable=True, index=True)
    edited_at = db.Column(db.DateTime, nullable=True)

    # Reserved for game challenge cards (added with game challenges)
    game_challenge_id = db.Column(db.Integer, nullable=True)

    created_at = db.Column(db.DateTime, default=datetime.utcnow, index=True)
    read_at = db.Column(db.DateTime, nullable=True)


class MessageReaction(db.Model):
    """One reaction per user and emoji for a message."""
    id = db.Column(db.Integer, primary_key=True)
    message_id = db.Column(db.Integer, db.ForeignKey("message.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = db.Column(db.Integer, db.ForeignKey("user.id", ondelete="CASCADE"), nullable=False, index=True)
    emoji = db.Column(db.String(16), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)
    __table_args__ = (UniqueConstraint("message_id", "user_id", "emoji", name="uq_message_reaction_user_emoji"),)


class ChatPreference(db.Model):
    """Per-user presentation preferences for one conversation."""
    id = db.Column(db.Integer, primary_key=True)
    conversation_id = db.Column(db.Integer, db.ForeignKey("conversation.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = db.Column(db.Integer, db.ForeignKey("user.id", ondelete="CASCADE"), nullable=False, index=True)
    theme = db.Column(db.String(20), nullable=False, default="default")
    __table_args__ = (UniqueConstraint("conversation_id", "user_id", name="uq_chat_preference_user_conversation"),)


class ChatTyping(db.Model):
    """Short-lived typing status, expired by timestamp rather than explicit cleanup."""
    id = db.Column(db.Integer, primary_key=True)
    conversation_id = db.Column(db.Integer, db.ForeignKey("conversation.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = db.Column(db.Integer, db.ForeignKey("user.id", ondelete="CASCADE"), nullable=False, index=True)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False, index=True)
    __table_args__ = (UniqueConstraint("conversation_id", "user_id", name="uq_chat_typing_user_conversation"),)


class Post(db.Model):
    """A feed post. Visible to its author and the author's friends."""

    id = db.Column(db.Integer, primary_key=True)

    user_id = db.Column(
        db.Integer, db.ForeignKey("user.id"), nullable=False, index=True
    )

    content = db.Column(db.String(2000), nullable=True)
    image_filename = db.Column(db.String(64), nullable=True, index=True)

    # added later: older databases get these columns from ensure_columns()
    video_filename = db.Column(db.String(64), nullable=True)
    edited_at = db.Column(db.DateTime, nullable=True)

    # Sent by the browser once per post. If the same request arrives twice (a
    # double tap, a retry after a dropped connection) only one post is created.
    client_token = db.Column(db.String(40), nullable=True)

    created_at = db.Column(db.DateTime, default=datetime.utcnow, index=True)

    author = db.relationship("User", foreign_keys=[user_id])

    __table_args__ = (
        Index("ix_post_user_token", "user_id", "client_token", unique=True),
    )


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


class PrivacySetting(db.Model):
    """Who may see what. No row means the defaults below."""

    id = db.Column(db.Integer, primary_key=True)

    user_id = db.Column(
        db.Integer, db.ForeignKey("user.id"), unique=True, nullable=False
    )

    # only_me | friends | everyone
    email_visibility = db.Column(db.String(10), nullable=False, default="only_me")
    friends_visibility = db.Column(db.String(10), nullable=False, default="everyone")
    info_visibility = db.Column(db.String(10), nullable=False, default="everyone")


class PasswordReset(db.Model):
    """A one-time reset code. Only a keyed hash of the code is stored."""

    id = db.Column(db.Integer, primary_key=True)

    user_id = db.Column(
        db.Integer, db.ForeignKey("user.id"), nullable=False, index=True
    )

    code_hash = db.Column(db.String(64), nullable=False)
    attempts = db.Column(db.Integer, nullable=False, default=0)

    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    expires_at = db.Column(db.DateTime, nullable=False)
    used_at = db.Column(db.DateTime, nullable=True)


class GameChallenge(db.Model):
    """An invitation to play. status: pending | accepted | declined | cancelled | expired

    Only one pending challenge can exist between two people (either direction);
    the database enforces that with a partial unique index."""

    id = db.Column(db.Integer, primary_key=True)

    game = db.Column(db.String(20), nullable=False, default="pool8")

    challenger_id = db.Column(
        db.Integer, db.ForeignKey("user.id"), nullable=False, index=True
    )
    opponent_id = db.Column(
        db.Integer, db.ForeignKey("user.id"), nullable=False, index=True
    )

    # "<smaller user id>:<larger user id>"
    pair_key = db.Column(db.String(32), nullable=False)

    stake = db.Column(db.Integer, nullable=False, default=0)    # 0 = free demo match

    status = db.Column(db.String(12), nullable=False, default="pending")

    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    expires_at = db.Column(db.DateTime, nullable=False)
    responded_at = db.Column(db.DateTime, nullable=True)

    match_id = db.Column(db.Integer, nullable=True)
    rematch_of_match_id = db.Column(db.Integer, nullable=True)

    __table_args__ = (
        CheckConstraint("challenger_id != opponent_id", name="ck_challenge_not_self"),
        Index(
            "uq_game_challenge_pending_pair",
            "pair_key",
            unique=True,
            sqlite_where=text("status = 'pending'"),
        ),
    )


class GameMatch(db.Model):
    """A two-player match. The two player columns are the only two seats.

    status: waiting (both must press ready) | active | completed | cancelled
    The whole table lives in state_json and only the server changes it.
    version goes up on every change, so a stale or repeated request is rejected."""

    id = db.Column(db.Integer, primary_key=True)

    game = db.Column(db.String(20), nullable=False, default="pool8")
    challenge_id = db.Column(db.Integer, nullable=True)

    player1_id = db.Column(
        db.Integer, db.ForeignKey("user.id"), nullable=False, index=True
    )
    player2_id = db.Column(
        db.Integer, db.ForeignKey("user.id"), nullable=False, index=True
    )

    status = db.Column(db.String(12), nullable=False, default="waiting", index=True)

    stake = db.Column(db.Integer, nullable=False, default=0)
    # none = free match, nothing to settle. Money is never moved by this table.
    settlement_status = db.Column(db.String(16), nullable=False, default="none")

    state_json = db.Column(db.Text, nullable=False)
    last_shot_json = db.Column(db.Text, nullable=True)
    version = db.Column(db.Integer, nullable=False, default=0)

    winner_slot = db.Column(db.Integer, nullable=True)
    win_reason = db.Column(db.String(160), nullable=True)

    p1_ready = db.Column(db.Boolean, nullable=False, default=False)
    p2_ready = db.Column(db.Boolean, nullable=False, default=False)
    p1_seen = db.Column(db.DateTime, nullable=True)
    p2_seen = db.Column(db.DateTime, nullable=True)

    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    started_at = db.Column(db.DateTime, nullable=True)
    ended_at = db.Column(db.DateTime, nullable=True)

    __table_args__ = (
        CheckConstraint("player1_id != player2_id", name="ck_match_two_different_players"),
    )


class GameShot(db.Model):
    """One row per accepted shot: who, aim and result. Kept as an audit trail."""

    id = db.Column(db.Integer, primary_key=True)

    match_id = db.Column(
        db.Integer, db.ForeignKey("game_match.id"), nullable=False, index=True
    )
    seq = db.Column(db.Integer, nullable=False)
    user_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)

    angle = db.Column(db.Float, nullable=False)
    power = db.Column(db.Float, nullable=False)

    foul = db.Column(db.Boolean, nullable=False, default=False)
    pocketed = db.Column(db.String(60), nullable=True)

    created_at = db.Column(db.DateTime, default=datetime.utcnow)


class SavedPost(db.Model):
    """A post someone bookmarked for later."""

    id = db.Column(db.Integer, primary_key=True)

    user_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False, index=True)
    post_id = db.Column(db.Integer, db.ForeignKey("post.id"), nullable=False, index=True)

    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("user_id", "post_id", name="uq_saved_post_pair"),
    )


class HiddenPost(db.Model):
    """A post someone chose not to see again. Only hides it for them."""

    id = db.Column(db.Integer, primary_key=True)

    user_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False, index=True)
    post_id = db.Column(db.Integer, db.ForeignKey("post.id"), nullable=False, index=True)

    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("user_id", "post_id", name="uq_hidden_post_pair"),
    )


class PostReport(db.Model):
    """A report about a post, for the admin to review. reason: spam | nudity |
    violence | harassment | false_info | other"""

    id = db.Column(db.Integer, primary_key=True)

    reporter_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False, index=True)
    post_id = db.Column(db.Integer, db.ForeignKey("post.id"), nullable=False, index=True)

    reason = db.Column(db.String(20), nullable=False)
    details = db.Column(db.String(200), nullable=True)

    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("reporter_id", "post_id", name="uq_post_report_pair"),
    )


class UserBlock(db.Model):
    """A directional block: blocker prevents the blocked user from messaging them."""
    id = db.Column(db.Integer, primary_key=True)
    blocker_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False, index=True)
    blocked_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False, index=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)
    __table_args__ = (
        UniqueConstraint("blocker_id", "blocked_id", name="uq_user_block_pair"),
        CheckConstraint("blocker_id != blocked_id", name="ck_user_block_not_self"),
    )


class UserReport(db.Model):
    """A report about a user for review in the existing admin dashboard."""
    id = db.Column(db.Integer, primary_key=True)
    reporter_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False, index=True)
    reported_user_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False, index=True)
    reason = db.Column(db.String(40), nullable=False)
    details = db.Column(db.String(500), nullable=True)
    status = db.Column(db.String(16), nullable=False, default="open", index=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False, index=True)
    reviewed_at = db.Column(db.DateTime, nullable=True)
    __table_args__ = (
        CheckConstraint("reporter_id != reported_user_id", name="ck_user_report_not_self"),
        CheckConstraint("status IN ('open', 'reviewed')", name="ck_user_report_status"),
    )


def ensure_columns():
    """Add columns that newer versions of the app need to tables made by older
    versions. Safe to run every start: it only adds what is missing and never
    touches existing data."""
    from sqlalchemy import inspect

    wanted = {
        "post": [
            ("video_filename", "VARCHAR(64)"),
            ("edited_at", "DATETIME"),
            ("client_token", "VARCHAR(40)"),
        ],
        "message": [
            ("audio_filename", "VARCHAR(64)"),
            ("sticker_key", "VARCHAR(32)"),
            ("reply_to_id", "INTEGER"),
            ("edited_at", "DATETIME"),
        ],
    }

    inspector = inspect(db.engine)

    for table, columns in wanted.items():
        if not inspector.has_table(table):
            continue

        existing = {c["name"] for c in inspector.get_columns(table)}

        for name, ddl in columns:
            if name not in existing:
                db.session.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}"))

        db.session.commit()

    # indexes that older databases do not have yet (NULL tokens never clash)
    if inspector.has_table("post"):
        db.session.execute(text(
            "CREATE UNIQUE INDEX IF NOT EXISTS ix_post_user_token ON post (user_id, client_token)"
        ))
        db.session.commit()


def delete_post_completely(post):
    """Remove a post and everything attached to it. The caller commits."""
    pid = post.id

    PostLike.query.filter_by(post_id=pid).delete(synchronize_session=False)
    PostComment.query.filter_by(post_id=pid).delete(synchronize_session=False)
    Notification.query.filter_by(post_id=pid).delete(synchronize_session=False)
    SavedPost.query.filter_by(post_id=pid).delete(synchronize_session=False)
    HiddenPost.query.filter_by(post_id=pid).delete(synchronize_session=False)
    PostReport.query.filter_by(post_id=pid).delete(synchronize_session=False)

    delete_upload_files([post.image_filename, post.video_filename], POST_DIR)

    db.session.delete(post)


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
        messages = Message.query.filter(Message.conversation_id.in_(conversation_ids)).all()
        message_ids = [m.id for m in messages]
        files = [m.image_filename for m in messages] + [m.audio_filename for m in messages]
        if message_ids:
            MessageReaction.query.filter(MessageReaction.message_id.in_(message_ids)).delete(synchronize_session=False)
        ChatPreference.query.filter(ChatPreference.conversation_id.in_(conversation_ids)).delete(synchronize_session=False)
        ChatTyping.query.filter(ChatTyping.conversation_id.in_(conversation_ids)).delete(synchronize_session=False)
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
        SavedPost.query.filter(SavedPost.post_id.in_(post_ids)).delete(synchronize_session=False)
        HiddenPost.query.filter(HiddenPost.post_id.in_(post_ids)).delete(synchronize_session=False)
        PostReport.query.filter(PostReport.post_id.in_(post_ids)).delete(synchronize_session=False)
        Post.query.filter(Post.id.in_(post_ids)).delete(synchronize_session=False)
        delete_upload_files(
            [p.image_filename for p in posts] + [p.video_filename for p in posts], POST_DIR)

    # What they saved, hid or reported
    SavedPost.query.filter_by(user_id=uid).delete(synchronize_session=False)
    HiddenPost.query.filter_by(user_id=uid).delete(synchronize_session=False)
    PostReport.query.filter_by(reporter_id=uid).delete(synchronize_session=False)
    UserReport.query.filter(
        or_(UserReport.reporter_id == uid, UserReport.reported_user_id == uid)
    ).delete(synchronize_session=False)
    UserBlock.query.filter(
        or_(UserBlock.blocker_id == uid, UserBlock.blocked_id == uid)
    ).delete(synchronize_session=False)

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

    # Their game challenges, matches and shots
    GameChallenge.query.filter(
        or_(GameChallenge.challenger_id == uid, GameChallenge.opponent_id == uid)
    ).delete(synchronize_session=False)

    match_ids = [
        g.id for g in GameMatch.query.filter(
            or_(GameMatch.player1_id == uid, GameMatch.player2_id == uid)
        ).all()
    ]

    if match_ids:
        GameShot.query.filter(GameShot.match_id.in_(match_ids)).delete(synchronize_session=False)
        GameMatch.query.filter(GameMatch.id.in_(match_ids)).delete(synchronize_session=False)

    PrivacySetting.query.filter_by(user_id=uid).delete(synchronize_session=False)
    PasswordReset.query.filter_by(user_id=uid).delete(synchronize_session=False)

    profile = Profile.query.filter_by(user_id=uid).first()
    if profile and profile.avatar_filename:
        delete_upload_files([profile.avatar_filename], AVATAR_DIR)

    Profile.query.filter_by(user_id=uid).delete(synchronize_session=False)

    db.session.delete(user)