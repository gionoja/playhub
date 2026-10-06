"""Login tokens. The browser sends:  Authorization: Bearer <token>"""
from datetime import datetime
from functools import wraps

from flask import current_app, g, jsonify, request
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from database import db
from models import Profile, User

TOKEN_MAX_AGE = 60 * 60 * 24 * 30  # 30 days


def _serializer():
    return URLSafeTimedSerializer(
        current_app.config["SECRET_KEY"], salt="playhub-auth"
    )


def create_token(user):
    return _serializer().dumps({"uid": user.id})


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

        if not user or not user.email_verified:
            return _unauthorized()

        g.user = user
        g.me_id = user.id

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