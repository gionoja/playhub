"""Your own account: profile edits, profile picture, privacy, password change
and the forgot-password flow. Everything here changes only the logged-in user."""
import hashlib
import hmac
import os
import re
import secrets
from datetime import datetime, timedelta

from flask import Blueprint, abort, current_app, g, jsonify, request, send_from_directory
from werkzeug.security import check_password_hash, generate_password_hash

from auth import create_token, login_required
from database import db
from email_service import send_reset_code_email
from models import AuthSession, LoginActivity, PasswordReset, PrivacySetting, Profile, User, UserBlock
from profiles import avatar_url
from signing import verified_viewer
from uploads import (
    AVATAR_DIR, MAX_IMAGE_BYTES, MIME, SAFE_NAME, ImageProblem,
    delete_upload_files, detect_image_type, make_avatar, save_image
)

accounts_bp = Blueprint("accounts", __name__)

MAX_NAME = 100
MAX_BIO = 160
MIN_PASSWORD = 8
MAX_PASSWORD = 128
RESET_LIFETIME = timedelta(minutes=15)
RESET_COOLDOWN = timedelta(seconds=60)
MAX_CODE_ATTEMPTS = 5

EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

VISIBILITY = {
    "email_visibility": ("only_me", "friends", "everyone"),
    "friends_visibility": ("everyone", "friends", "only_me"),
    "info_visibility": ("everyone", "friends", "only_me"),
}


def _error(message, status):
    return jsonify({"message": message}), status


def _profile(user):
    profile = Profile.query.filter_by(user_id=user.id).first()

    if not profile:
        profile = Profile(user_id=user.id)
        db.session.add(profile)
        db.session.commit()

    return profile


def password_problem(password, email=""):
    if len(password) < MIN_PASSWORD:
        return f"Your new password must be at least {MIN_PASSWORD} characters"

    if len(password) > MAX_PASSWORD:
        return f"Your new password can be at most {MAX_PASSWORD} characters"

    if email and password.lower() == email.lower():
        return "Your password can't be the same as your email"

    return None


def get_privacy(user_id):
    row = PrivacySetting.query.filter_by(user_id=user_id).first()

    return {
        "email_visibility": row.email_visibility if row else "only_me",
        "friends_visibility": row.friends_visibility if row else "everyone",
        "info_visibility": row.info_visibility if row else "everyone",
    }




@accounts_bp.route("/me/blocked-users", methods=["GET"])
@login_required
def list_blocked_users():
    """Return accounts blocked by the current user for Privacy settings."""
    blocks = UserBlock.query.filter_by(blocker_id=g.user.id).order_by(
        UserBlock.created_at.desc()
    ).all()
    blocked_ids = [row.blocked_id for row in blocks]
    users = User.query.filter(User.id.in_(blocked_ids)).all() if blocked_ids else []
    by_id = {user.id: user for user in users}
    return jsonify({
        "blocked_users": [
            {"username": by_id[row.blocked_id].username,
             "full_name": by_id[row.blocked_id].full_name}
            for row in blocks if row.blocked_id in by_id
        ]
    })


# ------------------------------------------------------------ edit profile

@accounts_bp.route("/me/profile", methods=["PUT"])
@login_required
def update_profile():
    data = request.get_json(silent=True) or {}
    profile = _profile(g.user)

    if "full_name" in data:
        name = (data.get("full_name") or "").strip()

        if not name:
            return _error("Please enter your name", 400)

        if len(name) > MAX_NAME:
            return _error(f"Names can be up to {MAX_NAME} characters", 400)

        g.user.full_name = name

    if "bio" in data:
        bio = (data.get("bio") or "").strip()

        if len(bio) > MAX_BIO:
            return _error(f"Your bio can be up to {MAX_BIO} characters", 400)

        profile.bio = bio              # an empty bio removes it

    db.session.commit()

    return jsonify({"full_name": g.user.full_name, "bio": profile.bio})


# ---------------------------------------------------------- profile picture

@accounts_bp.route("/me/avatar", methods=["POST"])
@login_required
def upload_avatar():
    upload = request.files.get("image")

    if not upload:
        return _error("Choose a photo first", 400)

    data = upload.read(MAX_IMAGE_BYTES + 1)

    if len(data) > MAX_IMAGE_BYTES:
        return _error("That image is too large. The limit is 5 MB.", 413)

    ext = detect_image_type(data[:16])

    if not ext:
        return _error("Only JPG, PNG, GIF or WebP images are allowed", 400)

    try:
        data, ext = make_avatar(data, ext)
    except ImageProblem as problem:
        return _error(str(problem), 400)

    profile = _profile(g.user)
    old = profile.avatar_filename

    profile.avatar_filename = save_image(data, ext, AVATAR_DIR)
    db.session.commit()

    delete_upload_files([old], AVATAR_DIR)

    return jsonify({"avatar_url": avatar_url(g.me_id)})


@accounts_bp.route("/me/avatar", methods=["DELETE"])
@login_required
def remove_avatar():
    profile = _profile(g.user)
    old = profile.avatar_filename

    profile.avatar_filename = None
    db.session.commit()

    delete_upload_files([old], AVATAR_DIR)

    return jsonify({"avatar_url": None})


@accounts_bp.route("/avatars/images/<filename>")
def serve_avatar(filename):
    if not SAFE_NAME.match(filename) or verified_viewer("avatars", filename) is None:
        abort(404)

    # only a file that is somebody's current picture can be fetched
    if not Profile.query.filter_by(avatar_filename=filename).first():
        abort(404)

    response = send_from_directory(
        AVATAR_DIR, filename, mimetype=MIME[filename.rsplit(".", 1)[1]]
    )
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Cache-Control"] = "private, max-age=86400, immutable"
    return response


# ------------------------------------------------------------------ privacy

@accounts_bp.route("/me/privacy")
@login_required
def read_privacy():
    return jsonify(get_privacy(g.me_id))


@accounts_bp.route("/me/privacy", methods=["PUT"])
@login_required
def update_privacy():
    data = request.get_json(silent=True) or {}

    for field, allowed in VISIBILITY.items():
        if field in data and data[field] not in allowed:
            return _error("That privacy choice isn't valid", 400)

    row = PrivacySetting.query.filter_by(user_id=g.me_id).first()

    if not row:
        row = PrivacySetting(user_id=g.me_id)
        db.session.add(row)

    for field in VISIBILITY:
        if field in data:
            setattr(row, field, data[field])

    db.session.commit()

    return jsonify(get_privacy(g.me_id))


# ---------------------------------------------------------- change password

@accounts_bp.route("/me/password", methods=["POST"])
@login_required
def change_password():
    data = request.get_json(silent=True) or {}

    current = data.get("current_password") or ""
    new = data.get("new_password") or ""

    if not check_password_hash(g.user.password_hash, current):
        return _error("Your current password isn't correct", 403)

    problem = password_problem(new, g.user.email)

    if problem:
        return _error(problem, 400)

    if check_password_hash(g.user.password_hash, new):
        return _error("Choose a password you haven't used just now", 400)

    g.user.password_hash = generate_password_hash(new)
    AuthSession.query.filter_by(user_id=g.me_id, revoked_at=None).update(
        {"revoked_at": datetime.utcnow()}, synchronize_session=False
    )
    db.session.commit()

    # Password change revokes every previous device; issue one fresh session here.
    return jsonify({"message": "Password updated", "token": create_token(g.user)})


# ------------------------------------------------------- forgot / reset flow

def _code_hash(user_id, code):
    secret = current_app.config["SECRET_KEY"].encode()
    return hmac.new(secret, f"{user_id}:{code}".encode(), hashlib.sha256).hexdigest()


def _clean_email(value):
    return (value or "").strip()


@accounts_bp.route("/password/forgot", methods=["POST"])
def forgot_password():
    email = _clean_email((request.get_json(silent=True) or {}).get("email"))

    if not EMAIL_PATTERN.match(email):
        return _error("Enter a valid email address", 400)

    user = User.query.filter_by(email=email).first()

    if not user:
        return _error("No PlayHub account uses that email", 404)

    if not user.email_verified:
        return _error(
            "That email hasn't been verified yet. Check your inbox for the "
            "verification link, or sign up again to get a new one.", 403
        )

    latest = PasswordReset.query.filter_by(user_id=user.id).order_by(
        PasswordReset.id.desc()
    ).first()

    if latest and datetime.utcnow() - latest.created_at < RESET_COOLDOWN:
        wait = int((RESET_COOLDOWN - (datetime.utcnow() - latest.created_at)).total_seconds()) + 1
        return _error(f"Please wait {wait} seconds before asking for another code", 429)

    # only the newest code works
    PasswordReset.query.filter_by(user_id=user.id, used_at=None).update(
        {"used_at": datetime.utcnow()}, synchronize_session=False
    )

    code = f"{secrets.randbelow(10 ** 6):06d}"

    reset = PasswordReset(
        user_id=user.id,
        code_hash=_code_hash(user.id, code),
        expires_at=datetime.utcnow() + RESET_LIFETIME,
    )
    db.session.add(reset)
    db.session.commit()

    try:
        send_reset_code_email(current_app._get_current_object(), email, code)
    except Exception:
        reset.used_at = datetime.utcnow()
        db.session.commit()
        return _error("We couldn't send the email right now. Please try again shortly.", 502)

    return jsonify({
        "message": "We sent a 6-digit code to your email",
        "expires_in": int(RESET_LIFETIME.total_seconds()),
        "resend_after": int(RESET_COOLDOWN.total_seconds()),
    })


@accounts_bp.route("/password/reset", methods=["POST"])
def reset_password():
    data = request.get_json(silent=True) or {}

    email = _clean_email(data.get("email"))
    code = str(data.get("code") or "").strip()
    new = data.get("new_password") or ""

    if not EMAIL_PATTERN.match(email):
        return _error("Enter a valid email address", 400)

    user = User.query.filter_by(email=email).first()

    if not user:
        return _error("No PlayHub account uses that email", 404)

    problem = password_problem(new, user.email)

    if problem:
        return _error(problem, 400)

    if not re.fullmatch(r"\d{6}", code):
        return _error("Enter the 6-digit code from your email", 400)

    reset = PasswordReset.query.filter_by(user_id=user.id, used_at=None).order_by(
        PasswordReset.id.desc()
    ).first()

    if not reset:
        return _error("There's no active reset request. Ask for a new code.", 400)

    if reset.expires_at < datetime.utcnow():
        reset.used_at = datetime.utcnow()
        db.session.commit()
        return _error("This code has expired. Ask for a new one.", 400)

    if reset.attempts >= MAX_CODE_ATTEMPTS:
        reset.used_at = datetime.utcnow()
        db.session.commit()
        return _error("Too many wrong attempts. Ask for a new code.", 429)

    if not hmac.compare_digest(reset.code_hash, _code_hash(user.id, code)):
        reset.attempts += 1
        left = MAX_CODE_ATTEMPTS - reset.attempts

        if left <= 0:
            reset.used_at = datetime.utcnow()

        db.session.commit()

        if left <= 0:
            return _error("Too many wrong attempts. Ask for a new code.", 429)

        return _error(f"That code isn't correct. {left} attempt{'s' if left != 1 else ''} left.", 400)

    user.password_hash = generate_password_hash(new)

    PasswordReset.query.filter_by(user_id=user.id, used_at=None).update(
        {"used_at": datetime.utcnow()}, synchronize_session=False
    )
    db.session.commit()

    return jsonify({"message": "Password updated. You can log in now."})

# ---------------------------------------------------------- security centre

def _security_device(session):
    ua = session.user_agent or "Unknown device"
    lower = ua.lower()
    if "edg/" in lower: browser = "Microsoft Edge"
    elif "opr/" in lower or "opera" in lower: browser = "Opera"
    elif "firefox/" in lower: browser = "Firefox"
    elif "chrome/" in lower: browser = "Chrome"
    elif "safari/" in lower: browser = "Safari"
    else: browser = "Unknown browser"
    if "android" in lower: platform = "Android"
    elif "iphone" in lower or "ipad" in lower: platform = "iOS"
    elif "windows" in lower: platform = "Windows"
    elif "mac os" in lower or "macintosh" in lower: platform = "macOS"
    elif "linux" in lower: platform = "Linux"
    else: platform = "Unknown device"
    return {"id": session.id, "browser": browser, "platform": platform,
            "ip_address": session.ip_address, "created_at": session.created_at.isoformat() + "Z",
            "last_seen": session.last_seen.isoformat() + "Z", "current": session.id == g.session_id}


@accounts_bp.route("/me/security", methods=["GET"])
@login_required
def security_overview():
    now = datetime.utcnow()
    sessions = AuthSession.query.filter_by(user_id=g.me_id, revoked_at=None).filter(
        AuthSession.expires_at > now
    ).order_by(AuthSession.last_seen.desc()).all()
    activity = LoginActivity.query.filter_by(user_id=g.me_id).order_by(
        LoginActivity.created_at.desc()
    ).limit(30).all()
    return jsonify({
        "email_verified": bool(g.user.email_verified),
        "two_factor_enabled": False,
        "sessions": [_security_device(item) for item in sessions],
        "activity": [{"event": item.event, "success": item.success,
                      "ip_address": item.ip_address,
                      "created_at": item.created_at.isoformat() + "Z"}
                     for item in activity],
    })


@accounts_bp.route("/me/security/sessions/<session_id>", methods=["DELETE"])
@login_required
def revoke_security_session(session_id):
    session = AuthSession.query.filter_by(id=session_id, user_id=g.me_id, revoked_at=None).first()
    if not session:
        return _error("That session was not found or has already been signed out", 404)
    session.revoked_at = datetime.utcnow()
    db.session.commit()
    return jsonify({"message": "Device signed out"})


@accounts_bp.route("/me/security/sessions/logout-others", methods=["POST"])
@login_required
def revoke_other_security_sessions():
    count = AuthSession.query.filter(
        AuthSession.user_id == g.me_id,
        AuthSession.id != g.session_id,
        AuthSession.revoked_at.is_(None),
    ).update({"revoked_at": datetime.utcnow()}, synchronize_session=False)
    db.session.commit()
    return jsonify({"message": "Other devices signed out", "count": count})


@accounts_bp.route("/me/security/logout-all", methods=["POST"])
@login_required
def revoke_all_security_sessions():
    AuthSession.query.filter_by(user_id=g.me_id, revoked_at=None).update(
        {"revoked_at": datetime.utcnow()}, synchronize_session=False
    )
    db.session.commit()
    return jsonify({"message": "All sessions signed out. Please log in again."})


@accounts_bp.route("/me/security/logout-current", methods=["POST"])
@login_required
def revoke_current_security_session():
    session = db.session.get(AuthSession, g.session_id)
    if session and session.revoked_at is None:
        session.revoked_at = datetime.utcnow()
        db.session.commit()
    return jsonify({"message": "This device has been signed out"})
