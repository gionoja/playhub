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
from models import (
    Post, PostReport, User, UserReport, delete_post_completely, delete_user_completely
)

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

    delete_user_completely(user)
    db.session.commit()
    return jsonify({"message": "User deleted"})


@admin_bp.route("/api/users/purge-expired", methods=["POST"])
def purge_expired():
    """Delete accounts that were never verified and whose link has expired."""
    removed = 0
    for user in User.query.filter_by(email_verified=False).all():
        if _status(user) == "expired":
            delete_user_completely(user)
            removed += 1
    db.session.commit()
    return jsonify({"message": f"{removed} expired account(s) deleted", "removed": removed})


@admin_bp.route("/api/reports")
def list_reports():
    """Reported posts, most reported first, with every reason given."""
    reports = PostReport.query.order_by(PostReport.id.asc()).all()

    by_post = {}

    for r in reports:
        by_post.setdefault(r.post_id, []).append(r)

    posts = {
        p.id: p for p in Post.query.filter(Post.id.in_(list(by_post))).all()
    } if by_post else {}

    users = {
        u.id: u for u in User.query.filter(
            User.id.in_([p.user_id for p in posts.values()]
                        + [r.reporter_id for r in reports])
        ).all()
    } if reports else {}

    result = []

    for post_id, items in by_post.items():
        post = posts.get(post_id)

        if not post:
            continue

        author = users.get(post.user_id)

        result.append({
            "post_id": post_id,
            "author": author.username if author else "(deleted)",
            "text": (post.content or "")[:300],
            "has_image": bool(post.image_filename),
            "has_video": bool(post.video_filename),
            "count": len(items),
            "first_reported": items[0].created_at.isoformat() + "Z",
            "reports": [
                {
                    "reason": r.reason,
                    "details": r.details or "",
                    "by": users[r.reporter_id].username if r.reporter_id in users else "(deleted)",
                }
                for r in items
            ],
        })

    result.sort(key=lambda r: (-r["count"], r["first_reported"]))

    return jsonify(result)


@admin_bp.route("/api/user-reports")
def list_user_reports():
    reports = UserReport.query.filter_by(status="open").order_by(UserReport.created_at.desc(), UserReport.id.desc()).all()
    ids = {r.reporter_id for r in reports} | {r.reported_user_id for r in reports}
    users = {u.id: u for u in User.query.filter(User.id.in_(ids)).all()} if ids else {}
    return jsonify([{
        "id": r.id,
        "reporter_id": r.reporter_id,
        "reporter": users[r.reporter_id].username if r.reporter_id in users else "(deleted)",
        "reported_user_id": r.reported_user_id,
        "reported_user": users[r.reported_user_id].username if r.reported_user_id in users else "(deleted)",
        "reason": r.reason,
        "details": r.details or "",
        "created_at": r.created_at.isoformat() + "Z",
    } for r in reports])


@admin_bp.route("/api/user-reports/<int:report_id>/review", methods=["POST"])
def review_user_report(report_id):
    report = db.session.get(UserReport, report_id)
    if not report:
        return jsonify({"message": "User report not found"}), 404
    report.status = "reviewed"
    report.reviewed_at = datetime.utcnow()
    db.session.commit()
    return jsonify({"message": "User report marked as reviewed"})


@admin_bp.route("/api/reports/<int:post_id>/dismiss", methods=["POST"])
def dismiss_reports(post_id):
    """The post is fine: clear the reports against it."""
    PostReport.query.filter_by(post_id=post_id).delete(synchronize_session=False)
    db.session.commit()

    return jsonify({"message": "Reports dismissed"})


@admin_bp.route("/api/posts/<int:post_id>", methods=["DELETE"])
def remove_post(post_id):
    """Take a post down (its likes, comments, reports and media go with it)."""
    post = db.session.get(Post, post_id)

    if not post:
        return jsonify({"message": "Post not found"}), 404

    delete_post_completely(post)
    db.session.commit()

    return jsonify({"message": "Post removed"})


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
  .tabs { display: flex; gap: 6px; margin-bottom: 14px; }
  .tabs button.active { background: var(--brand); color: #fff; border-color: var(--brand); }
  .report { padding: 14px; border-bottom: 1px solid var(--line); }
  .report:last-child { border-bottom: 0; }
  .report .top { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: space-between; }
  .report .text { margin: 8px 0; white-space: pre-wrap; word-break: break-word; }
  .report .meta { color: var(--muted); font-size: 13px; }
  .report ul { margin: 8px 0 0 18px; color: var(--muted); font-size: 14px; }
  .actions { display: flex; gap: 8px; }
</style>
</head>
<body>
<header>
  <div class="logo">PLAY<span>HUB</span><span class="tag">Admin</span></div>
  <button id="refresh">Refresh</button>
</header>

<main>
  <div class="tabs">
    <button id="tabUsers" class="active">Users</button>
    <button id="tabReports">Post reports <span id="reportCount"></span></button>
    <button id="tabUserReports">User reports <span id="userReportCount"></span></button>
  </div>

  <section id="userReportsPanel" hidden>
    <div class="summary" id="userReportSummary"></div>
    <div class="table-wrap" id="userReportList"></div>
  </section>

  <section id="reportsPanel" hidden>
    <div class="summary" id="reportSummary"></div>
    <div class="table-wrap" id="reportList"></div>
  </section>

  <section id="usersPanel">
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
  </section>
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

  // ---- reported posts
  const REASONS = {
    spam: "Spam or scam", nudity: "Nudity or sexual content", violence: "Violence or dangerous content",
    harassment: "Harassment or bullying", false_info: "False information", other: "Something else"
  };

  async function loadReports() {
    const res = await fetch("/admin/api/reports", { headers: HEADERS });
    if (!res.ok) { toast("Could not load reports (" + res.status + ")"); return; }
    renderReports(await res.json());
  }

  function renderReports(reports) {
    const list = document.getElementById("reportList");
    list.replaceChildren();

    document.getElementById("reportCount").textContent = reports.length ? "(" + reports.length + ")" : "";
    document.getElementById("reportSummary").textContent =
      reports.length + (reports.length === 1 ? " reported post" : " reported posts");

    if (!reports.length) {
      const none = document.createElement("div");
      none.className = "empty";
      none.textContent = "No reported posts. Nothing needs your attention.";
      list.append(none);
      return;
    }

    for (const r of reports) {
      const box = document.createElement("div");
      box.className = "report";

      const top = document.createElement("div");
      top.className = "top";

      const title = document.createElement("strong");
      title.textContent = "Post #" + r.post_id + " by @" + r.author + "  (" + r.count + (r.count === 1 ? " report)" : " reports)");

      const actions = document.createElement("div");
      actions.className = "actions";

      const dismiss = document.createElement("button");
      dismiss.textContent = "Dismiss reports";
      dismiss.onclick = async () => {
        if (!confirm("Keep this post and clear its reports?")) return;
        const res = await fetch("/admin/api/reports/" + r.post_id + "/dismiss", { method: "POST", headers: HEADERS });
        toast(res.ok ? "Reports dismissed" : "Failed (" + res.status + ")");
        loadReports();
      };

      const remove = document.createElement("button");
      remove.className = "danger";
      remove.textContent = "Remove post";
      remove.onclick = async () => {
        if (!confirm("Permanently remove this post, with its likes, comments and media?")) return;
        const res = await fetch("/admin/api/posts/" + r.post_id, { method: "DELETE", headers: HEADERS });
        toast(res.ok ? "Post removed" : "Failed (" + res.status + ")");
        loadReports();
      };

      actions.append(dismiss, remove);
      top.append(title, actions);

      const text = document.createElement("div");
      text.className = "text";
      text.textContent = r.text || (r.has_video ? "(video post)" : r.has_image ? "(photo post)" : "(empty)");

      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = (r.has_image ? "Has a photo. " : "") + (r.has_video ? "Has a video. " : "") +
        "First reported " + new Date(r.first_reported).toLocaleString();

      const reasons = document.createElement("ul");
      for (const x of r.reports) {
        const li = document.createElement("li");
        li.textContent = (REASONS[x.reason] || x.reason) + (x.details ? ": " + x.details : "") + "  (by @" + x.by + ")";
        reasons.append(li);
      }

      box.append(top, text, meta, reasons);
      list.append(box);
    }
  }

  async function loadUserReports() {
    const res = await fetch("/admin/api/user-reports", { headers: HEADERS });
    if (!res.ok) { toast("Could not load user reports (" + res.status + ")"); return; }
    renderUserReports(await res.json());
  }

  function renderUserReports(reports) {
    const list = document.getElementById("userReportList");
    list.replaceChildren();
    document.getElementById("userReportCount").textContent = reports.length ? "(" + reports.length + ")" : "";
    document.getElementById("userReportSummary").textContent = reports.length + (reports.length === 1 ? " open user report" : " open user reports");
    if (!reports.length) {
      const none = document.createElement("div"); none.className = "empty";
      none.textContent = "No open user reports. Nothing needs your attention."; list.append(none); return;
    }
    for (const r of reports) {
      const box = document.createElement("div"); box.className = "report";
      const top = document.createElement("div"); top.className = "top";
      const title = document.createElement("strong"); title.textContent = "@" + r.reported_user + " reported by @" + r.reporter;
      const actions = document.createElement("div"); actions.className = "actions";
      const review = document.createElement("button"); review.textContent = "Mark reviewed";
      review.onclick = async () => {
        if (!confirm("Mark this user report as reviewed?")) return;
        const res = await fetch("/admin/api/user-reports/" + r.id + "/review", { method: "POST", headers: HEADERS });
        const data = await res.json().catch(() => ({}));
        toast(res.ok ? (data.message || "Report reviewed") : (data.message || "Review failed"));
        if (res.ok) loadUserReports();
      };
      const del = document.createElement("button"); del.className = "danger"; del.textContent = "Delete reported user";
      del.onclick = async () => {
        if (!confirm("Permanently delete @" + r.reported_user + " and their account data? This cannot be undone.")) return;
        const res = await fetch("/admin/api/users/" + r.reported_user_id, { method: "DELETE", headers: HEADERS });
        const data = await res.json().catch(() => ({}));
        toast(res.ok ? "Reported user deleted" : (data.message || "Delete failed"));
        if (res.ok) { loadUserReports(); load(); }
      };
      actions.append(review, del); top.append(title, actions);
      const reason = document.createElement("div"); reason.className = "text"; reason.textContent = "Reason: " + r.reason;
      const details = document.createElement("div"); details.className = "text"; details.textContent = r.details || "No additional details provided.";
      const meta = document.createElement("div"); meta.className = "meta"; meta.textContent = "Reported " + new Date(r.created_at).toLocaleString();
      box.append(top, reason, details, meta); list.append(box);
    }
  }

  function showTab(name) {
    const posts = name === "reports", userReports = name === "user-reports";
    document.getElementById("usersPanel").hidden = posts || userReports;
    document.getElementById("reportsPanel").hidden = !posts;
    document.getElementById("userReportsPanel").hidden = !userReports;
    document.getElementById("tabUsers").classList.toggle("active", name === "users");
    document.getElementById("tabReports").classList.toggle("active", posts);
    document.getElementById("tabUserReports").classList.toggle("active", userReports);
    if (posts) loadReports(); if (userReports) loadUserReports();
  }
  document.getElementById("tabUsers").onclick = () => showTab("users");
  document.getElementById("tabReports").onclick = () => showTab("reports");
  document.getElementById("tabUserReports").onclick = () => showTab("user-reports");
  document.getElementById("refresh").onclick = () => {
    load();
    if (!document.getElementById("reportsPanel").hidden) loadReports();
    if (!document.getElementById("userReportsPanel").hidden) loadUserReports();
  };
  search.addEventListener("input", render);
  load();
  fetch("/admin/api/reports", { headers: HEADERS }).then(r => r.ok ? r.json() : []).then(list => {
    document.getElementById("reportCount").textContent = list.length ? "(" + list.length + ")" : "";
  });
  fetch("/admin/api/user-reports", { headers: HEADERS }).then(r => r.ok ? r.json() : []).then(list => {
    document.getElementById("userReportCount").textContent = list.length ? "(" + list.length + ")" : "";
  });
</script>
</body>
</html>
"""