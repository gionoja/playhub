import os

from flask_mail import Mail, Message
from dotenv import load_dotenv

load_dotenv()

mail = Mail()


def send_verification_email(app, email, token):

    verification_link = (
        "http://10.0.85.58:5000/verify?token="
        + token
    )

    message = Message(
        subject="Verify your PLAYHUB account",
        sender=os.getenv("MAIL_USERNAME"),
        recipients=[email]
    )

    message.body = f"""
Welcome to PLAYHUB!

Please verify your email address by clicking the link below:

{verification_link}

This verification link will expire in 30 minutes.

If you did not create a PLAYHUB account, you can ignore this email.
"""

    with app.app_context():
        mail.send(message)


def send_reset_code_email(app, email, code):

    message = Message(
        subject="Your PLAYHUB password reset code",
        sender=os.getenv("MAIL_USERNAME"),
        recipients=[email]
    )

    message.body = f"""
Hello,

Use this code to reset your PLAYHUB password:

{code}

The code expires in 15 minutes and can only be used once.

If you did not ask to reset your password, you can ignore this email.
Your password will not change.
"""

    with app.app_context():
        mail.send(message)