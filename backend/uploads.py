"""Where uploaded images live, and the checks every upload must pass."""
import io
import os
import re
import secrets

try:
    from PIL import Image, ImageOps
    Image.MAX_IMAGE_PIXELS = 40_000_000       # refuse decompression bombs
except ImportError:                              # app still runs without Pillow
    Image = None
    ImageOps = None

UPLOAD_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "uploads")
MESSAGE_DIR = os.path.join(UPLOAD_ROOT, "messages")
POST_DIR = os.path.join(UPLOAD_ROOT, "posts")
STORY_DIR = os.path.join(UPLOAD_ROOT, "stories")
AVATAR_DIR = os.path.join(UPLOAD_ROOT, "avatars")

MAX_IMAGE_BYTES = 5 * 1024 * 1024  # 5 MB

# Saved names are always random hex + one of these extensions
SAFE_NAME = re.compile(r"^[0-9a-f]{32}\.(jpg|png|gif|webp)$")

MIME = {"jpg": "image/jpeg", "png": "image/png", "gif": "image/gif", "webp": "image/webp"}

for _folder in (MESSAGE_DIR, POST_DIR, STORY_DIR, AVATAR_DIR):
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


class ImageProblem(Exception):
    """The file claims to be an image but cannot be decoded safely."""


def prepare_image(data, ext, max_side=1600):
    """Decode, shrink and re-save an uploaded image.

    This proves the file is a real image, makes large photos load faster, and
    strips hidden metadata such as GPS location. GIFs are checked but kept as
    they are so animations still work."""
    if Image is None:
        return data, ext

    try:
        Image.open(io.BytesIO(data)).verify()

        if ext == "gif":
            return data, ext

        img = ImageOps.exif_transpose(Image.open(io.BytesIO(data)))

        if max(img.size) > max_side:
            img.thumbnail((max_side, max_side), Image.LANCZOS)

        out = io.BytesIO()

        if ext == "jpg":
            img.convert("RGB").save(out, "JPEG", quality=85, optimize=True)
        elif ext == "png":
            img.save(out, "PNG", optimize=True)
        else:
            img.save(out, "WEBP", quality=85)

        return out.getvalue(), ext

    except Exception:
        raise ImageProblem("That image could not be read. Try a different file.")


def make_avatar(data, ext, size=320):
    """Square, centre-cropped profile picture saved as a small JPEG."""
    if Image is None:
        return data, ext

    try:
        Image.open(io.BytesIO(data)).verify()

        img = ImageOps.exif_transpose(Image.open(io.BytesIO(data)))
        img = img.convert("RGBA")

        flat = Image.new("RGB", img.size, "white")
        flat.paste(img, mask=img.split()[-1])

        flat = ImageOps.fit(flat, (size, size), Image.LANCZOS)

        out = io.BytesIO()
        flat.save(out, "JPEG", quality=88, optimize=True)

        return out.getvalue(), "jpg"

    except Exception:
        raise ImageProblem("That image could not be read. Try a different file.")


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