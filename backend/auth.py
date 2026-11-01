"""Login tokens. The browser sends:  Authorization: Bearer <token>"""
import hashlib
from datetime import datetime, timedelta
from functools import wraps

from flask import current_app, g, has_request_context, jsonify, request
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from database import db
from models import AuthSession, Profile, User

TOKEN_MAX_AGE = 60 * 60 * 24 * 30  # 30 days


def _serializer():
    return URLSafeTimedSerializer(
        current_app.config["SECRET_KEY"], salt="playhub-auth"
    )


def _password_stamp(user):
    # Changes whenever the password changes, which invalidates older logins
    return hashlib.sha256(user.password_hash.encode()).hexdigest()[:12]


def create_token(user):
    session_id = __import__("uuid").uuid4().hex
    now = datetime.utcnow()
    user_agent = request.headers.get("User-Agent", "") if has_request_context() else ""
    remote_ip = (request.headers.get("X-Forwarded-For", request.remote_addr or "") if has_request_context() else "")
    session = AuthSession(
        id=session_id, user_id=user.id, created_at=now, last_seen=now,
        expires_at=now + timedelta(seconds=TOKEN_MAX_AGE),
        user_agent=user_agent[:500],
        ip_address=remote_ip.split(",")[0].strip()[:64],
    )
    db.session.add(session)
    db.session.commit()
    return _serializer().dumps({"uid": user.id, "pv": _password_stamp(user), "sid": session_id})


def _unauthorized():
    return jsonify({"message": "Please log in again"}), 401


def login_required(view):
    """Rejects the request unless it carries a valid token for a verified user.
    On success, g.user and g.me_id are set."""

    @wraps(view)
    def wrapper(*args, **kwargs):
        header = request.headers.get("Authorization", "")

        if not header.startswith("Bearer "):
            return _unauthorized()

        try:
            payload = _serializer().loads(
                header[len("Bearer "):], max_age=TOKEN_MAX_AGE
            )
        except (BadSignature, SignatureExpired):
            return _unauthorized()

        user = db.session.get(User, payload.get("uid"))
        session = db.session.get(AuthSession, payload.get("sid"))
        now = datetime.utcnow()

        if (
            not user or not user.email_verified
            or payload.get("pv") != _password_stamp(user)
            or not session or session.user_id != user.id
            or session.revoked_at is not None or session.expires_at < now
        ):
            return _unauthorized()

        g.user = user
        g.me_id = user.id
        g.session_id = session.id
        if (now - session.last_seen).total_seconds() > 60:
            session.last_seen = now
            session.ip_address = (request.headers.get("X-Forwarded-For", request.remote_addr or "").split(",")[0].strip())[:64]
            db.session.commit()

        # Remember when they were last active (at most once a minute)
        profile = Profile.query.filter_by(user_id=user.id).first()
        now = datetime.utcnow()
        if profile and (
            not profile.last_seen
            or (now - profile.last_seen).total_seconds() > 60
        ):
            profile.last_seen = now
            db.session.commit()

        return view(*args, **kwargs)

    return wrapper