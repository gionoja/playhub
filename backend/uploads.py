"""Where uploaded images live, and the checks every upload must pass."""
import os
import re
import secrets

UPLOAD_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "uploads")
MESSAGE_DIR = os.path.join(UPLOAD_ROOT, "messages")
POST_DIR = os.path.join(UPLOAD_ROOT, "posts")
STORY_DIR = os.path.join(UPLOAD_ROOT, "stories")

MAX_IMAGE_BYTES = 5 * 1024 * 1024  # 5 MB

# Saved names are always random hex + one of these extensions
SAFE_NAME = re.compile(r"^[0-9a-f]{32}\.(jpg|png|gif|webp)$")

MIME = {"jpg": "image/jpeg", "png": "image/png", "gif": "image/gif", "webp": "image/webp"}

for _folder in (MESSAGE_DIR, POST_DIR, STORY_DIR):
    os.makedirs(_folder, exist_ok=True)


def detect_image_type(data):
    """Look at the file's own first bytes. The name and the browser's
    content-type are never trusted. SVG is deliberately not allowed."""
    if data.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return None


def save_image(data, ext, folder):
    name = secrets.token_hex(16) + "." + ext
    with open(os.path.join(folder, name), "wb") as f:
        f.write(data)
    return name


def save_message_image(data, ext):
    return save_image(data, ext, MESSAGE_DIR)


def delete_upload_files(names, folder=MESSAGE_DIR):
    for name in names:
        if name and SAFE_NAME.match(name):
            try:
                os.remove(os.path.join(folder, name))
            except OSError:
                pass