"""World Chat backend tests: messages, replies, unread-reply tracking, invitations, migration.

Run from the backend folder:   python -m pytest tests -q
Uses a throwaway SQLite file, never instance/playhub.db.
"""
import sqlite3

import pytest
from flask import Flask

from auth import create_token
from database import db
from models import User, UserBlock
import world_chat
from world_chat import WorldChatMessage, ensure_world_chat_columns, world_chat_bp


@pytest.fixture()
def app(tmp_path):
    app = Flask(__name__)
    app.config.update(
        SECRET_KEY="test-secret",
        SQLALCHEMY_DATABASE_URI="sqlite:///" + str(tmp_path / "test.db"),
        SQLALCHEMY_TRACK_MODIFICATIONS=False,
        TESTING=True,
    )
    db.init_app(app)
    app.register_blueprint(world_chat_bp)
    with app.app_context():
        db.create_all()
        for name in ("alice", "bob", "cara"):
            db.session.add(User(
                full_name=name.title(), username=name, email=f"{name}@example.com",
                password_hash="x", email_verified=True,
            ))
        db.session.commit()
    return app


@pytest.fixture()
def client(app):
    return app.test_client()


@pytest.fixture()
def ids(app):
    with app.app_context():
        return {u.username: u.id for u in User.query.all()}


@pytest.fixture()
def auth(app, ids):
    """auth('bob') -> headers carrying bob's login token."""
    def make(name):
        with app.app_context():
            token = create_token(db.session.get(User, ids[name]))
        return {"Authorization": "Bearer " + token}
    return make


def send(client, headers, body, reply_to_id=None):
    payload = {"body": body}
    if reply_to_id is not None:
        payload["reply_to_id"] = reply_to_id
    return client.post("/world-chat/messages", json=payload, headers=headers)


def unread(client, headers):
    return client.get("/world-chat/unread-count", headers=headers).get_json()["count"]


# ------------------------------------------------------------------ auth

@pytest.mark.parametrize("method,path", [
    ("get", "/world-chat/messages"),
    ("post", "/world-chat/messages"),
    ("get", "/world-chat/unread-count"),
    ("get", "/world-chat/replies/unread"),
    ("post", "/world-chat/replies/read"),
    ("post", "/world-chat/invitations"),
])
def test_endpoints_require_login(client, method, path):
    assert getattr(client, method)(path).status_code == 401


# ------------------------------------------------------------ basic chat

def test_send_and_fetch_messages_with_sender_and_time(client, auth):
    r = send(client, auth("alice"), "hello world")
    assert r.status_code == 201
    data = client.get("/world-chat/messages", headers=auth("bob")).get_json()
    m = data["messages"][0]
    assert m["body"] == "hello world"
    assert m["sender"]["username"] == "alice" and m["sender"]["full_name"] == "Alice"
    assert m["created_at"].endswith("Z")
    assert m["mine"] is False
    assert client.get("/world-chat/messages", headers=auth("alice")).get_json()["messages"][0]["mine"] is True


def test_empty_and_overlong_messages_rejected(client, auth):
    assert send(client, auth("alice"), "   ").status_code == 400
    assert send(client, auth("alice"), "x" * 2001).status_code == 400


def test_incremental_fetch_after_id(client, auth):
    first = send(client, auth("alice"), "one").get_json()["message"]["id"]
    send(client, auth("alice"), "two")
    data = client.get(f"/world-chat/messages?after_id={first}", headers=auth("bob")).get_json()
    assert [m["body"] for m in data["messages"]] == ["two"]


# -------------------------------------------------- unread reply rules

def test_ordinary_messages_never_raise_unread(client, auth):
    send(client, auth("alice"), "my message")
    send(client, auth("bob"), "just chatting")
    send(client, auth("cara"), "community message")
    assert unread(client, auth("alice")) == 0
    assert unread(client, auth("bob")) == 0


def test_game_invitation_is_not_an_unread_reply(client, auth):
    send(client, auth("alice"), "my message")
    client.post("/world-chat/invitations", json={"game_type": "Ludo"}, headers=auth("bob"))
    assert unread(client, auth("alice")) == 0
    assert unread(client, auth("bob")) == 0


def test_direct_reply_raises_unread_only_for_the_original_author(client, auth):
    parent = send(client, auth("alice"), "who wants to play?").get_json()["message"]["id"]
    assert send(client, auth("bob"), "me!", parent).status_code == 201
    assert unread(client, auth("alice")) == 1
    assert unread(client, auth("bob")) == 0
    assert unread(client, auth("cara")) == 0


def test_own_reply_to_own_message_does_not_notify(client, auth):
    parent = send(client, auth("alice"), "thought one").get_json()["message"]["id"]
    send(client, auth("alice"), "thought two", parent)
    assert unread(client, auth("alice")) == 0


def test_reply_to_someone_else_notifies_them_not_the_replier(client, auth):
    parent = send(client, auth("bob"), "bob says hi").get_json()["message"]["id"]
    send(client, auth("alice"), "hi bob", parent)
    assert unread(client, auth("bob")) == 1
    assert unread(client, auth("alice")) == 0


def test_polling_and_reloading_do_not_inflate_the_count(client, auth):
    parent = send(client, auth("alice"), "question").get_json()["message"]["id"]
    send(client, auth("bob"), "answer", parent)
    for _ in range(5):
        assert unread(client, auth("alice")) == 1
        client.get("/world-chat/messages", headers=auth("alice"))
        client.get("/world-chat/replies/unread", headers=auth("alice"))
    assert unread(client, auth("alice")) == 1


def test_two_replies_count_as_two(client, auth):
    parent = send(client, auth("alice"), "question").get_json()["message"]["id"]
    send(client, auth("bob"), "answer one", parent)
    send(client, auth("cara"), "answer two", parent)
    assert unread(client, auth("alice")) == 2


def test_history_payload_flags_unread_reply_and_preview(client, auth):
    parent = send(client, auth("alice"), "original text").get_json()["message"]["id"]
    send(client, auth("bob"), "the reply", parent)

    for_alice = client.get("/world-chat/messages", headers=auth("alice")).get_json()
    reply = [m for m in for_alice["messages"] if m["body"] == "the reply"][0]
    assert reply["unread_reply"] is True
    assert reply["reply_to"]["id"] == parent
    assert reply["reply_to"]["body"] == "original text"
    assert reply["reply_to"]["mine"] is True
    assert for_alice["unread_reply_count"] == 1

    for_bob = client.get("/world-chat/messages", headers=auth("bob")).get_json()
    assert [m for m in for_bob["messages"] if m["body"] == "the reply"][0]["unread_reply"] is False
    assert for_bob["unread_reply_count"] == 0


def test_long_parent_is_truncated_in_preview(client, auth):
    parent = send(client, auth("alice"), "y" * 600).get_json()["message"]["id"]
    reply = send(client, auth("bob"), "ok", parent).get_json()["message"]
    assert len(reply["reply_to"]["body"]) <= world_chat.REPLY_PREVIEW_CHARS + 1


def test_reply_to_an_invitation_message_is_a_normal_reply(client, auth):
    inv = client.post("/world-chat/invitations", json={"game_type": "Snooker"}, headers=auth("alice")).get_json()
    send(client, auth("bob"), "count me in", inv["message"]["id"])
    assert unread(client, auth("alice")) == 1


# ---------------------------------------------------------- mark read

def test_mark_read_clears_and_is_idempotent(client, auth):
    parent = send(client, auth("alice"), "q").get_json()["message"]["id"]
    reply = send(client, auth("bob"), "a", parent).get_json()["message"]["id"]

    r = client.post("/world-chat/replies/read", json={"message_ids": [reply]}, headers=auth("alice")).get_json()
    assert r == {"marked": 1, "count": 0}
    again = client.post("/world-chat/replies/read", json={"message_ids": [reply]}, headers=auth("alice")).get_json()
    assert again == {"marked": 0, "count": 0}
    assert unread(client, auth("alice")) == 0
    msgs = client.get("/world-chat/messages", headers=auth("alice")).get_json()["messages"]
    assert [m for m in msgs if m["id"] == reply][0]["unread_reply"] is False


def test_cannot_mark_someone_elses_replies_read(client, auth):
    parent = send(client, auth("alice"), "q").get_json()["message"]["id"]
    reply = send(client, auth("bob"), "a", parent).get_json()["message"]["id"]
    r = client.post("/world-chat/replies/read", json={"message_ids": [reply]}, headers=auth("cara")).get_json()
    assert r["marked"] == 0
    assert unread(client, auth("alice")) == 1


def test_mark_read_only_touches_listed_ids(client, auth):
    parent = send(client, auth("alice"), "q").get_json()["message"]["id"]
    r1 = send(client, auth("bob"), "a1", parent).get_json()["message"]["id"]
    send(client, auth("cara"), "a2", parent)
    client.post("/world-chat/replies/read", json={"message_ids": [r1]}, headers=auth("alice"))
    assert unread(client, auth("alice")) == 1


def test_new_reply_after_clearing_counts_again(client, auth):
    parent = send(client, auth("alice"), "q").get_json()["message"]["id"]
    r1 = send(client, auth("bob"), "a1", parent).get_json()["message"]["id"]
    client.post("/world-chat/replies/read", json={"message_ids": [r1]}, headers=auth("alice"))
    send(client, auth("bob"), "a2", parent)
    assert unread(client, auth("alice")) == 1


def test_unread_replies_list(client, auth):
    parent = send(client, auth("alice"), "q").get_json()["message"]["id"]
    send(client, auth("bob"), "a", parent)
    data = client.get("/world-chat/replies/unread", headers=auth("alice")).get_json()
    assert data["count"] == 1 and data["replies"][0]["body"] == "a"
    assert data["replies"][0]["reply_to"]["body"] == "q"


@pytest.mark.parametrize("payload", [{}, {"message_ids": []}, {"message_ids": "5"}, {"message_ids": ["x"]}])
def test_mark_read_validates_input(client, auth, payload):
    assert client.post("/world-chat/replies/read", json=payload, headers=auth("alice")).status_code == 400


# ------------------------------------------------------ reply validation

def test_reply_to_missing_message_is_404(client, auth):
    assert send(client, auth("bob"), "hi", 99999).status_code == 404


def test_reply_to_invalid_id_is_400(client, auth):
    assert send(client, auth("bob"), "hi", "abc").status_code == 400


def test_blocked_users_reply_is_posted_but_does_not_notify(app, client, auth, ids):
    parent = send(client, auth("alice"), "q").get_json()["message"]["id"]
    with app.app_context():
        db.session.add(UserBlock(blocker_id=ids["alice"], blocked_id=ids["bob"]))
        db.session.commit()
    assert send(client, auth("bob"), "a", parent).status_code == 201
    assert unread(client, auth("alice")) == 0


# ------------------------------------------------------- game invitations

def invite(client, headers, **kw):
    body = {"game_type": "Ludo", "details": "casual", "max_participants": 3}
    body.update(kw)
    return client.post("/world-chat/invitations", json=body, headers=headers)


def test_invitation_create_join_leave_and_counts(client, auth):
    r = invite(client, auth("alice"))
    assert r.status_code == 201
    inv = r.get_json()["invitation"]
    assert inv["participant_count"] == 1 and inv["hosted_by_me"] is True

    j = client.post(f"/world-chat/invitations/{inv['id']}/join", headers=auth("bob")).get_json()["invitation"]
    assert j["participant_count"] == 2 and j["joined_by_me"] is True and j["hosted_by_me"] is False

    l = client.post(f"/world-chat/invitations/{inv['id']}/leave", headers=auth("bob")).get_json()["invitation"]
    assert l["participant_count"] == 1 and l["joined_by_me"] is False


def test_invitation_full_and_host_cannot_leave(client, auth):
    inv = invite(client, auth("alice"), max_participants=2).get_json()["invitation"]
    client.post(f"/world-chat/invitations/{inv['id']}/join", headers=auth("bob"))
    assert client.post(f"/world-chat/invitations/{inv['id']}/join", headers=auth("cara")).status_code == 409
    assert client.post(f"/world-chat/invitations/{inv['id']}/leave", headers=auth("alice")).status_code == 409


def test_only_host_can_update_invitation_status(client, auth):
    inv = invite(client, auth("alice")).get_json()["invitation"]
    url = f"/world-chat/invitations/{inv['id']}/state"
    assert client.post(url, json={"state": "STARTED"}, headers=auth("bob")).status_code == 403
    ok = client.post(url, json={"state": "STARTED"}, headers=auth("alice"))
    assert ok.status_code == 200 and ok.get_json()["invitation"]["state"] == "STARTED"
    assert client.post(f"/world-chat/invitations/{inv['id']}/join", headers=auth("cara")).status_code == 409


def test_invitation_validation(client, auth):
    assert invite(client, auth("alice"), game_type="").status_code == 400
    assert invite(client, auth("alice"), max_participants=1).status_code == 400
    assert invite(client, auth("alice"), max_participants="many").status_code == 400


# --------------------------------------------------------------- migration

def test_migration_adds_columns_to_old_table_without_losing_rows(tmp_path):
    path = tmp_path / "old.db"
    con = sqlite3.connect(path)
    con.executescript("""
        CREATE TABLE world_chat_messages (
            id INTEGER PRIMARY KEY, sender_id INTEGER NOT NULL, message_type VARCHAR(24) NOT NULL,
            body VARCHAR(2000) NOT NULL, invitation_id INTEGER, created_at DATETIME NOT NULL);
        INSERT INTO world_chat_messages (sender_id, message_type, body, created_at)
            VALUES (1, 'TEXT', 'legacy message', '2026-10-01 10:00:00');
    """)
    con.commit(); con.close()

    app = Flask(__name__)
    app.config.update(SQLALCHEMY_DATABASE_URI="sqlite:///" + str(path), SQLALCHEMY_TRACK_MODIFICATIONS=False)
    db.init_app(app)
    with app.app_context():
        ensure_world_chat_columns()
        ensure_world_chat_columns()   # running twice must be harmless
        cols = {r[1] for r in db.session.execute(db.text("PRAGMA table_info(world_chat_messages)"))}
        assert {"reply_to_id", "reply_notify_user_id", "reply_read_at"} <= cols
        row = db.session.execute(db.text("SELECT body, reply_to_id, reply_notify_user_id FROM world_chat_messages")).one()
        assert tuple(row) == ("legacy message", None, None)


def test_migration_is_a_noop_when_table_is_missing(tmp_path):
    app = Flask(__name__)
    app.config.update(SQLALCHEMY_DATABASE_URI="sqlite:///" + str(tmp_path / "empty.db"), SQLALCHEMY_TRACK_MODIFICATIONS=False)
    db.init_app(app)
    with app.app_context():
        ensure_world_chat_columns()


# ------------------------------------------------- live invitation updates

def test_history_reports_server_time_and_invitation_changes(client, auth):
    inv = invite(client, auth("alice")).get_json()["invitation"]
    first = client.get("/world-chat/messages", headers=auth("alice")).get_json()
    assert first["server_time"].endswith("Z")

    client.post(f"/world-chat/invitations/{inv['id']}/join", headers=auth("bob"))
    poll = client.get(
        "/world-chat/messages?after_id=999&inv_since=" + first["server_time"], headers=auth("alice")
    ).get_json()
    update = [u for u in poll["invitation_updates"] if u["id"] == inv["id"]][0]
    assert update["participant_count"] == 2
    assert update["hosted_by_me"] is True and update["joined_by_me"] is True   # viewer-specific


def test_no_invitation_updates_without_inv_since_or_when_nothing_changed(client, auth):
    invite(client, auth("alice"))
    assert client.get("/world-chat/messages", headers=auth("bob")).get_json()["invitation_updates"] == []


def test_bad_inv_since_is_400(client, auth):
    assert client.get("/world-chat/messages?inv_since=garbage", headers=auth("alice")).status_code == 400
