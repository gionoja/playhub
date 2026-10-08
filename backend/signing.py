"""Image links that browsers can cache.

<img> tags cannot send a login header, so each image URL carries a signature
tied to the person looking at it. The signature changes once a day, so the
same URL is reused all day (the browser keeps the picture instead of
downloading it again on every refresh), and old links stop working after
about 24-48 hours. Access is still checked on the server for every request."""
import hashlib
import hmac
import time

from flask import current_app, request

BUCKET_SECONDS = 24 * 60 * 60


def _signature(kind, filename, viewer_id, bucket):
    secret = current_app.config["SECRET_KEY"].encode()
    message = f"{kind}|{filename}|{viewer_id}|{bucket}".encode()
    return hmac.new(secret, message, hashlib.sha256).hexdigest()[:32]


def signed_url(kind, filename, viewer_id):
    bucket = int(time.time() // BUCKET_SECONDS)
    sig = _signature(kind, filename, viewer_id, bucket)
    return f"/{kind}/images/{filename}?u={viewer_id}&b={bucket}&s={sig}"


def verified_viewer(kind, filename):
    """The viewer id the link was signed for, or None if it is invalid/expired."""
    viewer = request.args.get("u", type=int)
    bucket = request.args.get("b", type=int)
    sig = request.args.get("s", "")

    if viewer is None or bucket is None:
        return None

    now = int(time.time() // BUCKET_SECONDS)

    if bucket not in (now, now - 1):
        return None

    expected = _signature(kind, filename, viewer, bucket)

    return viewer if hmac.compare_digest(expected, sig) else None