from flask import Flask, request, jsonify

from flask_cors import CORS

from werkzeug.security import generate_password_hash, check_password_hash

import secrets

from datetime import datetime, timedelta

import os

from dotenv import load_dotenv

from flask_mail import Mail

from database import db

from models import User

from email_service import mail, send_verification_email
from admin import admin_bp
from verify_page import render_verify_page

load_dotenv()

app = Flask(__name__)

CORS(app)

app.config["MAIL_SERVER"] = "smtp.gmail.com"
app.config["MAIL_PORT"] = 587
app.config["MAIL_USE_TLS"] = True
app.config["MAIL_USERNAME"] = os.getenv("MAIL_USERNAME")
app.config["MAIL_PASSWORD"] = os.getenv("MAIL_PASSWORD")

app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///playhub.db"
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False

mail.init_app(app)

db.init_app(app)

app.register_blueprint(admin_bp)


with app.app_context():
    db.create_all()


def generate_username(full_name):
    username = full_name.lower().replace(" ", "")

    original = username
    number = 1

    while User.query.filter_by(username=username).first():
        username = original + str(number)
        number += 1

    return username


@app.route("/")
def home():
    return "PLAYHUB backend is running"


@app.route("/signup", methods=["POST"])
def signup():

    data = request.get_json()

    full_name = data.get("full_name")
    email = data.get("email")
    password = data.get("password")

    if not full_name or not email or not password:
        return jsonify({
            "message": "All fields are required"
        }), 400

    existing_user = User.query.filter_by(email=email).first()

    if existing_user:
        if existing_user.email_verified:
            return jsonify({
                "message": "Email already exists"
            }), 409

        # Earlier signup was never verified: replace it with this new one
        db.session.delete(existing_user)
        db.session.commit()

    username = generate_username(full_name)

    password_hash = generate_password_hash(password)

    verification_token = secrets.token_urlsafe(32)

    user = User(
        full_name=full_name,
        username=username,
        email=email,
        password_hash=password_hash,
        verification_token=verification_token,
        verification_token_expires=datetime.utcnow() + timedelta(minutes=30)
    )

    db.session.add(user)
    db.session.commit()

    send_verification_email(
        app,
        email,
        verification_token
    )

    return jsonify({
        "message": "Account created successfully. Check your email to verify your account.",
        "username": username
    }), 201

@app.route("/verify")
def verify_email():

    token = request.args.get("token")

    if not token:
        return render_verify_page("invalid")

    user = User.query.filter_by(
        verification_token=token
    ).first()

    if not user:
        return render_verify_page("invalid")

    if user.email_verified:
        return render_verify_page("already")

    if (
        not user.verification_token_expires
        or user.verification_token_expires < datetime.utcnow()
    ):
        return render_verify_page("expired")

    user.email_verified = True
    user.verification_token = None
    user.verification_token_expires = None

    db.session.commit()

    return render_verify_page("success")


@app.route("/verification-status")
def verification_status():
    """The signup screen calls this every few seconds while it waits for the email link to be tapped."""

    email = (request.args.get("email") or "").strip()

    user = User.query.filter_by(email=email).first()

    return jsonify({
        "verified": bool(user and user.email_verified)
    })


@app.route("/login", methods=["POST"])
def login():

    data = request.get_json(silent=True) or {}

    email = (data.get("email") or "").strip()
    password = data.get("password") or ""

    if not email or not password:
        return jsonify({
            "message": "Email and password are required"
        }), 400

    user = User.query.filter_by(email=email).first()

    if not user or not check_password_hash(user.password_hash, password):
        return jsonify({
            "message": "Invalid email or password"
        }), 401

    if not user.email_verified:
        return jsonify({
            "message": "Please verify your email before logging in. Check your inbox for the link.",
            "code": "email_not_verified"
        }), 403

    return jsonify({
        "message": "Login successful",
        "user": {
            "full_name": user.full_name,
            "username": user.username,
            "email": user.email
        }
    }), 200


if __name__ == "__main__":
    app.run(
        host="0.0.0.0",
        port=5000,
        debug=True
    )