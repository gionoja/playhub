"""Profile pictures: one batched lookup so lists never cost one query per person."""
from flask import g

from models import Profile
from signing import signed_url


def preload_avatars(user_ids, viewer_id=None):
    viewer_id = viewer_id or g.me_id
    cache = g.__dict__.setdefault("avatar_cache", {})

    ids = {i for i in user_ids if i not in cache}

    if not ids:
        return

    found = dict(
        Profile.query.with_entities(Profile.user_id, Profile.avatar_filename)
        .filter(Profile.user_id.in_(ids)).all()
    )

    for uid in ids:
        name = found.get(uid)
        cache[uid] = signed_url("avatars", name, viewer_id) if name else None


def avatar_url(user_id):
    cache = g.__dict__.setdefault("avatar_cache", {})

    if user_id not in cache:
        preload_avatars([user_id])

    return cache[user_id]