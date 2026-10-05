"""
PlayHub admin panel: view and delete users from the browser.

Open http://<your-server>:5000/admin and sign in with the credentials from .env:
    ADMIN_PASSWORD=choose-a-long-password
    ADMIN_USERNAME=admin        (optional, defaults to "admin")

If ADMIN_PASSWORD is not set, the admin panel is switched off.
"""
import hmac
import os
from datetime import datetime

from flask import Blueprint, Response, abort, jsonify, request

from database import db
from models import User

admin_bp = Blueprint("admin", __name__, url_prefix="/admin")


def _same(a, b):
    return hmac.compare_digest((a or "").encode("utf-8"), (b or "").encode("utf-8"))


@admin_bp.before_request
def require_admin():
    password = os.getenv("ADMIN_PASSWORD")
    if not password:
        abort(503, "Admin panel is disabled. Set ADMIN_PASSWORD in your .env file.")

    username = os.getenv("ADMIN_USERNAME", "admin")
    auth = request.authorization

    if not (auth and _same(auth.username, username) and _same(auth.password, password)):
        return Response(
            "Admin login required",
            401,
            {"WWW-Authenticate": 'Basic realm="PlayHub Admin"'},
        )

    # Changing data needs a custom header that only our own page sends.
    if request.method != "GET" and request.headers.get("X-Admin-Request") != "1":
        abort(403)


@admin_bp.after_request
def no_cache(response):
    response.headers["Cache-Control"] = "no-store"
    return response


def _status(user):
    if user.email_verified:
        return "verified"
    if user.verification_token_expires and user.verification_token_expires >= datetime.utcnow():
        return "pending"
    return "expired"


@admin_bp.route("/api/users")
def list_users():
    users = User.query.order_by(User.id.desc()).all()
    return jsonify([
        {
            "id": u.id,
            "full_name": u.full_name,
            "username": u.username,
            "email": u.email,
            "status": _status(u),
        }
        for u in users
    ])


@admin_bp.route("/api/users/<int:user_id>", methods=["DELETE"])
def delete_user(user_id):
    user = db.session.get(User, user_id)
    if not user:
        return jsonify({"message": "User not found"}), 404

    db.session.delete(user)
    db.session.commit()
    return jsonify({"message": "User deleted"})


@admin_bp.route("/api/users/purge-expired", methods=["POST"])
def purge_expired():
    """Delete accounts that were never verified and whose link has expired."""
    removed = 0
    for user in User.query.filter_by(email_verified=False).all():
        if _status(user) == "expired":
            db.session.delete(user)
            removed += 1
    db.session.commit()
    return jsonify({"message": f"{removed} expired account(s) deleted", "removed": removed})


@admin_bp.route("/")
def admin_page():
    return Response(ADMIN_HTML, mimetype="text/html")


ADMIN_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PlayHub Admin</title>
<style>
  :root {
    --bg: #f5f6fa; --card: #ffffff; --text: #1b1e2b; --muted: #6b7185;
    --line: #e3e6ef; --brand: #6c4cf5; --danger: #d92d3f; --ok: #12805c;
    --warn: #a15c00; --bad: #8a8fa3;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #12131a; --card: #1c1e29; --text: #eceefa; --muted: #9aa0b8;
      --line: #2c2f3f; --brand: #8e78ff; --danger: #ff6b79; --ok: #3ccf9c;
      --warn: #f0b24a; --bad: #7c8199;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
         font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  header { display: flex; align-items: center; justify-content: space-between;
           padding: 16px 24px; background: var(--card); border-bottom: 1px solid var(--line); }
  .logo { font-weight: 800; letter-spacing: 1px; }
  .logo span { color: var(--brand); }
  .tag { margin-left: 10px; color: var(--muted); font-weight: 500; letter-spacing: 0; }
  main { max-width: 1000px; margin: 24px auto; padding: 0 16px; }
  .toolbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 14px; }
  .toolbar input { flex: 1; min-width: 200px; padding: 10px 12px; border-radius: 8px;
                   border: 1px solid var(--line); background: var(--card); color: var(--text); font: inherit; }
  button { font: inherit; cursor: pointer; border-radius: 8px; padding: 9px 14px;
           border: 1px solid var(--line); background: var(--card); color: var(--text); }
  button:hover { border-color: var(--brand); }
  button:focus-visible, input:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
  button.danger { color: var(--danger); }
  button.danger:hover { border-color: var(--danger); }
  .summary { color: var(--muted); margin-bottom: 10px; }
  .table-wrap { overflow-x: auto; background: var(--card); border: 1px solid var(--line); border-radius: 10px; }
  table { width: 100%; border-collapse: collapse; min-width: 640px; }
  th, td { text-align: left; padding: 12px 14px; border-bottom: 1px solid var(--line); }
  th { color: var(--muted); font-weight: 600; font-size: 13px; }
  tr:last-child td { border-bottom: 0; }
  .badge { font-size: 13px; font-weight: 600; }
  .badge.verified { color: var(--ok); }
  .badge.pending { color: var(--warn); }
  .badge.expired { color: var(--bad); }
  .empty { padding: 36px; text-align: center; color: var(--muted); }
  #toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
           background: var(--text); color: var(--bg); padding: 10px 16px; border-radius: 8px;
           opacity: 0; pointer-events: none; transition: opacity .2s; }
  #toast.show { opacity: 1; }
</style>
</head>
<body>
<header>
  <div class="logo">PLAY<span>HUB</span><span class="tag">Admin</span></div>
  <button id="refresh">Refresh</button>
</header>

<main>
  <div class="toolbar">
    <input id="search" type="search" placeholder="Search by name, username or email" aria-label="Search users">
    <button id="purge" class="danger">Delete expired unverified</button>
  </div>
  <div class="summary" id="summary"></div>
  <div class="table-wrap">
    <table>
      <thead>
        <tr><th>ID</th><th>Name</th><th>Username</th><th>Email</th><th>Status</th><th></th></tr>
      </thead>
      <tbody id="rows"></tbody>
    </table>
    <div class="empty" id="empty" hidden>No users found.</div>
  </div>
</main>

<div id="toast" role="status"></div>

<script>
  const HEADERS = { "X-Admin-Request": "1" };
  let users = [];

  const rows = document.getElementById("rows");
  const empty = document.getElementById("empty");
  const summary = document.getElementById("summary");
  const search = document.getElementById("search");

  function toast(text) {
    const t = document.getElementById("toast");
    t.textContent = text;
    t.classList.add("show");
    setTimeout(() => t.classList.remove("show"), 2500);
  }

  async function load() {
    const res = await fetch("/admin/api/users", { headers: HEADERS });
    if (!res.ok) { toast("Could not load users (" + res.status + ")"); return; }
    users = await res.json();
    render();
  }

  function cell(text) {
    const td = document.createElement("td");
    td.textContent = text;   // textContent keeps user-entered names from running as HTML
    return td;
  }

  function render() {
    const q = search.value.trim().toLowerCase();
    const shown = users.filter(u =>
      !q || [u.full_name, u.username, u.email].some(v => (v || "").toLowerCase().includes(q)));

    rows.replaceChildren();
    for (const u of shown) {
      const tr = document.createElement("tr");
      tr.append(cell(u.id), cell(u.full_name), cell(u.username), cell(u.email));

      const status = document.createElement("td");
      const badge = document.createElement("span");
      badge.className = "badge " + u.status;
      badge.textContent = { verified: "Verified", pending: "Pending", expired: "Link expired" }[u.status];
      status.append(badge);

      const action = document.createElement("td");
      const del = document.createElement("button");
      del.className = "danger";
      del.textContent = "Delete";
      del.onclick = () => removeUser(u);
      action.append(del);

      tr.append(status, action);
      rows.append(tr);
    }

    empty.hidden = shown.length > 0;
    const verified = users.filter(u => u.status === "verified").length;
    summary.textContent = users.length + " users, " + verified + " verified";
  }

  async function removeUser(u) {
    if (!confirm("Delete " + u.email + "? This cannot be undone.")) return;
    const res = await fetch("/admin/api/users/" + u.id, { method: "DELETE", headers: HEADERS });
    toast(res.ok ? "User deleted" : "Delete failed (" + res.status + ")");
    load();
  }

  document.getElementById("purge").onclick = async () => {
    if (!confirm("Delete every unverified account whose link has expired?")) return;
    const res = await fetch("/admin/api/users/purge-expired", { method: "POST", headers: HEADERS });
    const data = await res.json();
    toast(data.message || "Done");
    load();
  };

  document.getElementById("refresh").onclick = load;
  search.addEventListener("input", render);
  load();
</script>
</body>
</html>
"""
