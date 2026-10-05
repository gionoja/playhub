"""Branded result page shown when someone taps the link in the verification email."""
import os
from flask import Response

PAGES = {
    "success": {
        "ok": True,
        "title": "Email verified successfully",
        "text": "Your email is confirmed. Log in to PlayHub to start playing.",
        "status": 200,
    },
    "already": {
        "ok": True,
        "title": "Email already verified",
        "text": "This account is already verified. You can log in to PlayHub.",
        "status": 200,
    },
    "expired": {
        "ok": False,
        "title": "This link has expired",
        "text": "Verification links last 30 minutes. Go back to PlayHub and sign up again to get a new one.",
        "status": 400,
    },
    "invalid": {
        "ok": False,
        "title": "This link isn't valid",
        "text": "It may have been used already or copied incorrectly. If you already verified, just log in to PlayHub.",
        "status": 400,
    },
}

ICON_OK = '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>'
ICON_BAD = '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>'

TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{title} | PlayHub</title>
<style>
  :root {{ --bg:#f5f6fa; --card:#fff; --text:#1b1e2b; --muted:#6b7185; --line:#e3e6ef;
          --brand:#6c4cf5; --ok:#12805c; --ok-bg:#e3f6ee; --bad:#d92d3f; --bad-bg:#fdeaec; }}
  @media (prefers-color-scheme: dark) {{
    :root {{ --bg:#12131a; --card:#1c1e29; --text:#eceefa; --muted:#9aa0b8; --line:#2c2f3f;
            --brand:#8e78ff; --ok:#3ccf9c; --ok-bg:#16322a; --bad:#ff6b79; --bad-bg:#3a1c21; }}
  }}
  * {{ box-sizing: border-box; }}
  body {{ margin:0; min-height:100vh; background:var(--bg); color:var(--text);
         font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
         display:flex; flex-direction:column; }}
  header {{ padding:20px 28px; }}
  .logo {{ font-weight:800; font-size:22px; letter-spacing:1px; }}
  .logo span {{ color:var(--brand); }}
  main {{ flex:1; display:flex; align-items:center; justify-content:center; padding:16px 16px 72px; }}
  .card {{ width:100%; max-width:440px; background:var(--card); border:1px solid var(--line);
          border-radius:16px; padding:40px 32px; text-align:center; }}
  .badge {{ width:60px; height:60px; border-radius:50%; margin:0 auto 20px;
           display:flex; align-items:center; justify-content:center; }}
  .badge.ok {{ background:var(--ok-bg); color:var(--ok); }}
  .badge.bad {{ background:var(--bad-bg); color:var(--bad); }}
  h1 {{ font-size:24px; margin:0 0 10px; }}
  p {{ margin:0; color:var(--muted); }}
  .btn {{ display:inline-block; margin-top:26px; padding:12px 24px; border-radius:10px;
         background:var(--brand); color:#fff; text-decoration:none; font-weight:600; }}
  .btn:focus-visible {{ outline:2px solid var(--brand); outline-offset:3px; }}
</style>
</head>
<body>
<header><div class="logo">PLAY<span>HUB</span></div></header>
<main>
  <div class="card">
    <div class="badge {kind}">{icon}</div>
    <h1>{title}</h1>
    <p>{text}</p>
    {button}
  </div>
</main>
</body>
</html>
"""


def render_verify_page(name):
    page = PAGES[name]
    frontend = os.getenv("FRONTEND_URL")
    button = ""
    if frontend and page["ok"]:
        button = f'<a class="btn" href="{frontend}">Log in to PlayHub</a>'
    html = TEMPLATE.format(
        kind="ok" if page["ok"] else "bad",
        icon=ICON_OK if page["ok"] else ICON_BAD,
        title=page["title"],
        text=page["text"],
        button=button,
    )
    return Response(html, status=page["status"], mimetype="text/html")
