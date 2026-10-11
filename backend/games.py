"""Two-player 8-ball pool: challenges, matches and shots.

The server owns the table. A player sends an aim angle and a power; the server
checks who they are, whose turn it is and that the table has not changed, runs
the physics, applies the rules and stores the result. Nobody can claim a win,
move a ball or change a turn by sending different data."""
import json
import math
import secrets
from datetime import datetime, timedelta

from flask import Blueprint, g, jsonify, request
from sqlalchemy import or_
from sqlalchemy.exc import IntegrityError

import pool_engine as engine
from auth import login_required
from database import db
from models import (
    Friendship, GameChallenge, GameMatch, GameShot, Profile, User
)
from profiles import avatar_url, preload_avatars

games_bp = Blueprint("games", __name__)

CHALLENGE_LIFETIME = timedelta(minutes=10)
WAITING_LIFETIME = timedelta(minutes=15)        # both players must press ready
ONLINE_WINDOW = timedelta(minutes=3)            # "online" in the friend list
CONNECTED_WINDOW = timedelta(seconds=12)        # heartbeat while in a match
CLAIM_AFTER = timedelta(seconds=120)            # opponent gone this long: you may claim
ABANDON_AFTER = timedelta(minutes=10)           # both gone this long: match cancelled


# ---------------------------------------------------------------- helpers

def _error(message, status, **extra):
    body = {"message": message}
    body.update(extra)
    return jsonify(body), status


def _iso(dt):
    return dt.isoformat() + "Z" if dt else None


def _now():
    return datetime.utcnow()


def _pair_key(a, b):
    return f"{min(a, b)}:{max(a, b)}"


def _are_friends(a, b):
    low, high = (a, b) if a < b else (b, a)
    return Friendship.query.filter_by(user_low_id=low, user_high_id=high).first() is not None


def _brief(user):
    return {
        "full_name": user.full_name,
        "username": user.username,
        "avatar_url": avatar_url(user.id),
    }


def _slot(match, user_id):
    if match.player1_id == user_id:
        return 1
    if match.player2_id == user_id:
        return 2
    return None


def _in_open_match(user_id):
    """The waiting/active match this person is already in, if any."""
    return GameMatch.query.filter(
        GameMatch.status.in_(("waiting", "active")),
        or_(GameMatch.player1_id == user_id, GameMatch.player2_id == user_id),
    ).first()


def _housekeeping():
    """Retire things nobody answered. Runs whenever someone looks, but only
    writes to the database when there is really something to retire."""
    now = _now()
    changed = False

    if db.session.query(GameChallenge.id).filter(
        GameChallenge.status == "pending", GameChallenge.expires_at < now
    ).first():
        GameChallenge.query.filter(
            GameChallenge.status == "pending", GameChallenge.expires_at < now
        ).update({"status": "expired", "responded_at": now}, synchronize_session=False)
        changed = True

    stale = GameMatch.status == "waiting", GameMatch.created_at < now - WAITING_LIFETIME

    if db.session.query(GameMatch.id).filter(*stale).first():
        GameMatch.query.filter(*stale).update(
            {"status": "cancelled", "ended_at": now, "win_reason": "Nobody started the match",
             "version": GameMatch.version + 1},
            synchronize_session=False,
        )
        changed = True

    gone = now - ABANDON_AFTER
    abandoned = (
        GameMatch.status == "active",
        or_(GameMatch.p1_seen.is_(None), GameMatch.p1_seen < gone),
        or_(GameMatch.p2_seen.is_(None), GameMatch.p2_seen < gone),
        or_(GameMatch.started_at.is_(None), GameMatch.started_at < gone),
    )

    if db.session.query(GameMatch.id).filter(*abandoned).first():
        GameMatch.query.filter(*abandoned).update(
            {"status": "cancelled", "ended_at": now,
             "win_reason": "Both players left, so the match was cancelled",
             "version": GameMatch.version + 1},
            synchronize_session=False,
        )
        changed = True

    if changed:
        db.session.commit()


def _challenge_dict(c, users):
    mine = c.challenger_id == g.me_id
    other_id = c.opponent_id if mine else c.challenger_id

    return {
        "id": c.id,
        "status": c.status,
        "direction": "outgoing" if mine else "incoming",
        "game": c.game,
        "stake": c.stake,
        "created_at": _iso(c.created_at),
        "expires_at": _iso(c.expires_at),
        "match_id": c.match_id,
        "rematch": c.rematch_of_match_id is not None,
        "user": _brief(users[other_id]),
    }


def _users_for(challenges):
    ids = {c.challenger_id for c in challenges} | {c.opponent_id for c in challenges}
    users = {u.id: u for u in User.query.filter(User.id.in_(ids)).all()} if ids else {}
    preload_avatars(list(users))
    return users


def _names(match, users):
    return {1: users[match.player1_id].full_name, 2: users[match.player2_id].full_name}


def _match_users(match):
    users = {u.id: u for u in User.query.filter(
        User.id.in_([match.player1_id, match.player2_id])).all()}
    preload_avatars(list(users))
    return users


def _status_label(match, mine_ready, theirs_ready, opponent_connected):
    if match.status == "waiting":
        return "Waiting for players"
    if match.status == "active":
        return "Match in progress" if opponent_connected else "Opponent disconnected"
    if match.status == "completed":
        return "Match completed"
    return "Match cancelled"


def _match_view(match, slot, since_shot=0):
    """What a player is allowed to see of a match."""
    users = _match_users(match)
    state = json.loads(match.state_json)
    now = _now()

    other_slot = 3 - slot
    other_seen = match.p1_seen if other_slot == 1 else match.p2_seen
    opponent_connected = bool(other_seen and now - other_seen < CONNECTED_WINDOW)

    players = []
    for s, uid in ((1, match.player1_id), (2, match.player2_id)):
        user = users[uid]
        players.append({
            "slot": s,
            **_brief(user),
            "ready": match.p1_ready if s == 1 else match.p2_ready,
            "group": state["groups"][str(s)],
            "left": len(engine.remaining(state, state["groups"][str(s)])) if state["groups"][str(s)] else None,
            "stats": state["stats"][str(s)],
        })

    can_claim = (
        match.status == "active"
        and not opponent_connected
        and (other_seen is None or now - other_seen >= CLAIM_AFTER)
        and (match.started_at is None or now - match.started_at >= CLAIM_AFTER)
    )

    view = {
        "id": match.id,
        "game": match.game,
        "status": match.status,
        "status_label": _status_label(
            match, None, None, opponent_connected or match.status != "active"),
        "you": slot,
        "players": players,
        "turn": state["turn"],
        "your_turn": match.status == "active" and state["turn"] == slot,
        "table_open": state["table_open"],
        "ball_in_hand": state["ball_in_hand"],
        "breaking": state["breaking"],
        "balls": state["balls"],
        "message": state["message"],
        "version": match.version,
        "shot_seq": state["shot_seq"],
        "opponent_connected": opponent_connected,
        "can_claim": can_claim,
        "stake": match.stake,
        "demo": match.stake == 0,
        "last_shot": None,
        "result": None,
    }

    if match.last_shot_json:
        shot = json.loads(match.last_shot_json)
        if shot["seq"] > since_shot:
            view["last_shot"] = shot

    if match.status in ("completed", "cancelled"):
        seconds = None
        if match.started_at and match.ended_at:
            seconds = int((match.ended_at - match.started_at).total_seconds())

        view["result"] = {
            "winner_slot": match.winner_slot,
            "you_won": match.winner_slot == slot if match.winner_slot else None,
            "reason": match.win_reason,
            "duration_seconds": seconds,
            "stats": state["stats"],
        }

    return view


def _touch(match, slot):
    """Record that this player is here. Returns True if the database changed.
    Only written every few seconds, which is plenty for a 12-second window."""
    column = "p1_seen" if slot == 1 else "p2_seen"
    seen = getattr(match, column)
    now = _now()

    if seen and now - seen < timedelta(seconds=3):
        return False

    setattr(match, column, now)
    return True


def _bump(match_id, version, values):
    """Change a match only if nobody else changed it first."""
    values = dict(values)
    values["version"] = version + 1

    rows = GameMatch.query.filter_by(id=match_id, version=version).update(
        values, synchronize_session=False
    )

    return rows == 1


def _participant_match(match_id):
    match = db.session.get(GameMatch, match_id)

    if not match:
        return None, None

    slot = _slot(match, g.me_id)

    return (match, slot) if slot else (None, None)


def _finish(match, winner_slot, reason, state=None):
    """Complete a match exactly once. Returns False if someone else already did."""
    values = {
        "status": "completed" if winner_slot else "cancelled",
        "winner_slot": winner_slot,
        "win_reason": reason,
        "ended_at": _now(),
    }

    if state is not None:
        values["state_json"] = json.dumps(state)

    rows = GameMatch.query.filter(
        GameMatch.id == match.id,
        GameMatch.version == match.version,
        GameMatch.status.in_(("waiting", "active")),
    ).update({**values, "version": match.version + 1}, synchronize_session=False)

    return rows == 1


# --------------------------------------------------------------- lobby

@games_bp.route("/games/pool/friends")
@login_required
def pool_friends():
    me = g.me_id

    rows = Friendship.query.filter(
        or_(Friendship.user_low_id == me, Friendship.user_high_id == me)
    ).all()

    ids = [f.user_high_id if f.user_low_id == me else f.user_low_id for f in rows]

    if not ids:
        return jsonify([])

    users = User.query.filter(User.id.in_(ids)).order_by(User.full_name).all()
    preload_avatars(ids)

    seen = dict(
        Profile.query.with_entities(Profile.user_id, Profile.last_seen)
        .filter(Profile.user_id.in_(ids)).all()
    )

    busy = set()
    for m in GameMatch.query.filter(
        GameMatch.status.in_(("waiting", "active")),
        or_(GameMatch.player1_id.in_(ids), GameMatch.player2_id.in_(ids)),
    ).all():
        busy.update((m.player1_id, m.player2_id))

    pending = {}
    for c in GameChallenge.query.filter(
        GameChallenge.status == "pending",
        or_(GameChallenge.challenger_id == me, GameChallenge.opponent_id == me),
    ).all():
        other = c.opponent_id if c.challenger_id == me else c.challenger_id
        pending[other] = "sent" if c.challenger_id == me else "received"

    now = _now()
    result = []

    for u in users:
        last = seen.get(u.id)
        result.append({
            **_brief(u),
            "online": bool(last and now - last < ONLINE_WINDOW),
            "busy": u.id in busy,
            "challenge": pending.get(u.id),
        })

    result.sort(key=lambda p: (not p["online"], p["full_name"].lower()))

    return jsonify(result)


@games_bp.route("/games/active")
@login_required
def active():
    """Everything the game screens poll for: invitations and your current match."""
    _housekeeping()

    me = g.me_id
    now = _now()

    challenges = GameChallenge.query.filter(
        or_(GameChallenge.challenger_id == me, GameChallenge.opponent_id == me),
        or_(
            GameChallenge.status == "pending",
            GameChallenge.responded_at > now - timedelta(minutes=2),
        ),
    ).order_by(GameChallenge.id.desc()).limit(10).all()

    users = _users_for(challenges)
    items = [_challenge_dict(c, users) for c in challenges]

    open_match = _in_open_match(me)
    match = None

    if open_match:
        slot = _slot(open_match, me)
        match = {
            "id": open_match.id,
            "status": open_match.status,
            "opponent": _brief(_match_users(open_match)[
                open_match.player2_id if slot == 1 else open_match.player1_id]),
        }

    return jsonify({
        "incoming": [c for c in items if c["direction"] == "incoming" and c["status"] == "pending"],
        "outgoing": [c for c in items if c["direction"] == "outgoing"],
        "match": match,
    })


# ----------------------------------------------------------- challenges

def _create_challenge(opponent, rematch_of=None):
    """Shared by "challenge a friend" and "rematch". Returns (response, status)."""
    me = g.me_id

    if opponent.id == me:
        return _error("You can't challenge yourself", 400)

    if not opponent.email_verified:
        return _error("User not found", 404)

    if not _are_friends(me, opponent.id):
        return _error("You can only challenge your friends", 403)

    if _in_open_match(me):
        return _error("Finish your current match before starting another", 409)

    if _in_open_match(opponent.id):
        return _error(f"{opponent.full_name} is in another match right now", 409)

    existing = GameChallenge.query.filter_by(
        pair_key=_pair_key(me, opponent.id), status="pending"
    ).first()

    if existing:
        if existing.challenger_id == me:
            return _error("You already challenged this friend. Wait for their answer.", 409)
        return _error(f"{opponent.full_name} already challenged you. Accept it instead.", 409)

    challenge = GameChallenge(
        challenger_id=me,
        opponent_id=opponent.id,
        pair_key=_pair_key(me, opponent.id),
        expires_at=_now() + CHALLENGE_LIFETIME,
        rematch_of_match_id=rematch_of,
    )
    db.session.add(challenge)

    try:
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        return _error("A challenge between you already exists", 409)

    users = {me: g.user, opponent.id: opponent}
    preload_avatars([me, opponent.id])

    return jsonify(_challenge_dict(challenge, users)), 201


@games_bp.route("/games/pool/challenges", methods=["POST"])
@login_required
def challenge_friend():
    _housekeeping()

    data = request.get_json(silent=True) or {}

    stake = data.get("stake", 0)

    # Real-money matches need a secure server-side wallet, which does not exist yet.
    if stake not in (0, None):
        return _error("Stake matches aren't available yet. Play a free match instead.", 400)

    opponent = User.query.filter_by(username=(data.get("username") or "").strip()).first()

    if not opponent:
        return _error("User not found", 404)

    return _create_challenge(opponent)


def _my_challenge(challenge_id, role):
    challenge = db.session.get(GameChallenge, challenge_id)

    if not challenge:
        return None

    wanted = challenge.opponent_id if role == "opponent" else challenge.challenger_id

    return challenge if wanted == g.me_id else None


def _start_match_from(challenge, swap=False):
    """Create the two-seat match for an accepted challenge."""
    p1, p2 = challenge.challenger_id, challenge.opponent_id

    if swap:
        p1, p2 = p2, p1

    state = engine.new_state(secrets.randbelow(2 ** 31), breaker_slot=1)

    match = GameMatch(
        game=challenge.game,
        challenge_id=challenge.id,
        player1_id=p1,
        player2_id=p2,
        stake=challenge.stake,
        settlement_status="none",
        state_json=json.dumps(state),
    )
    db.session.add(match)
    db.session.flush()

    challenge.match_id = match.id

    return match


@games_bp.route("/games/pool/challenges/<int:challenge_id>/accept", methods=["POST"])
@login_required
def accept_challenge(challenge_id):
    _housekeeping()

    challenge = _my_challenge(challenge_id, "opponent")

    if not challenge:
        return _error("Challenge not found", 404)

    if challenge.status == "expired":
        return _error("This challenge has expired", 410)

    if challenge.status != "pending":
        return _error("This challenge has already been answered", 409)

    if _in_open_match(g.me_id) or _in_open_match(challenge.challenger_id):
        return _error("One of you is already in a match", 409)

    # only one accept can win this race
    rows = GameChallenge.query.filter_by(id=challenge.id, status="pending").update(
        {"status": "accepted", "responded_at": _now()}, synchronize_session=False
    )

    if rows != 1:
        db.session.rollback()
        return _error("This challenge has already been answered", 409)

    db.session.refresh(challenge)

    swap = False
    if challenge.rematch_of_match_id:
        previous = db.session.get(GameMatch, challenge.rematch_of_match_id)
        # the other player breaks the rematch
        swap = bool(previous and previous.player1_id == challenge.challenger_id)

    match = _start_match_from(challenge, swap=swap)
    db.session.commit()

    return jsonify({"match_id": match.id, "message": "Challenge accepted"})


@games_bp.route("/games/pool/challenges/<int:challenge_id>/decline", methods=["POST"])
@login_required
def decline_challenge(challenge_id):
    challenge = _my_challenge(challenge_id, "opponent")

    if not challenge:
        return _error("Challenge not found", 404)

    rows = GameChallenge.query.filter_by(id=challenge.id, status="pending").update(
        {"status": "declined", "responded_at": _now()}, synchronize_session=False
    )
    db.session.commit()

    if rows != 1:
        return _error("This challenge has already been answered", 409)

    return jsonify({"message": "Challenge declined"})


@games_bp.route("/games/pool/challenges/<int:challenge_id>/cancel", methods=["POST"])
@login_required
def cancel_challenge(challenge_id):
    challenge = _my_challenge(challenge_id, "challenger")

    if not challenge:
        return _error("Challenge not found", 404)

    rows = GameChallenge.query.filter_by(id=challenge.id, status="pending").update(
        {"status": "cancelled", "responded_at": _now()}, synchronize_session=False
    )
    db.session.commit()

    if rows != 1:
        return _error("This challenge has already been answered", 409)

    return jsonify({"message": "Challenge cancelled"})


# ---------------------------------------------------------------- matches

@games_bp.route("/games/matches/<int:match_id>")
@login_required
def get_match(match_id):
    _housekeeping()

    match, slot = _participant_match(match_id)

    if not match:
        return _error("Match not found", 404)

    # this request doubles as the "I'm still here" signal
    if _touch(match, slot):
        db.session.commit()

    return jsonify(_match_view(match, slot, request.args.get("shot", 0, type=int)))


@games_bp.route("/games/matches/<int:match_id>/ready", methods=["POST"])
@login_required
def ready(match_id):
    match, slot = _participant_match(match_id)

    if not match:
        return _error("Match not found", 404)

    if match.status != "waiting":
        return _error("This match has already started or ended", 409)

    values = {"p1_ready" if slot == 1 else "p2_ready": True}
    both = (match.p2_ready if slot == 1 else match.p1_ready)

    if both:
        state = json.loads(match.state_json)
        users = _match_users(match)
        state["message"] = f"{users[match.player1_id].full_name} breaks. Aim, set your power and shoot."
        values.update({
            "status": "active",
            "started_at": _now(),
            "state_json": json.dumps(state),
        })

    values["p1_seen" if slot == 1 else "p2_seen"] = _now()

    if not _bump(match.id, match.version, values):
        db.session.rollback()
        db.session.expire_all()
        match = db.session.get(GameMatch, match_id)
        return jsonify(_match_view(match, slot))

    db.session.commit()
    db.session.expire_all()

    return jsonify(_match_view(db.session.get(GameMatch, match_id), slot))


def _finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


@games_bp.route("/games/matches/<int:match_id>/shot", methods=["POST"])
@login_required
def take_shot(match_id):
    match, slot = _participant_match(match_id)

    if not match:
        return _error("Match not found", 404)

    if match.status == "waiting":
        return _error("Both players need to press Ready first", 409)

    if match.status != "active":
        return _error("This match is over", 409)

    data = request.get_json(silent=True) or {}

    if data.get("version") != match.version:
        return _error("The table changed. Syncing with the latest position.", 409, resync=True)

    state = json.loads(match.state_json)

    if state["turn"] != slot:
        return _error("It's not your turn", 403)

    angle, power = data.get("angle"), data.get("power")

    if not _finite(angle) or not _finite(power) or not (0 < power <= 1.0001):
        return _error("That shot isn't valid", 400)

    cue_pos = None

    if state["ball_in_hand"]:
        pos = data.get("cue_pos")

        if (
            not isinstance(pos, (list, tuple)) or len(pos) != 2
            or not engine.valid_cue_placement(state["balls"], pos[0], pos[1])
        ):
            return _error("Place the cue ball on a free spot first", 400)

        cue_pos = (float(pos[0]), float(pos[1]))

    users = _match_users(match)
    names = _names(match, users)

    sim = engine.simulate(state["balls"], float(angle), min(float(power), 1.0), cue_pos)
    result = engine.resolve_shot(state, slot, sim, names)

    seq = state["shot_seq"]

    last_shot = {
        "seq": seq,
        "by": slot,
        "fps": engine.FPS,
        "seconds": sim.seconds,
        "frames": sim.frames,
        "events": sim.events,
        "summary": {
            "pocketed": result["pocketed"],
            "foul": result["foul"],
            "foul_reasons": result["foul_reasons"],
            "message": state["message"],
        },
    }

    values = {
        "state_json": json.dumps(state),
        "last_shot_json": json.dumps(last_shot, separators=(",", ":")),
        "p1_seen" if slot == 1 else "p2_seen": _now(),
    }

    if result["winner_slot"]:
        values.update({
            "status": "completed",
            "winner_slot": result["winner_slot"],
            "win_reason": result["win_reason"],
            "ended_at": _now(),
        })

    # the shot only counts if the table is still exactly as this player saw it
    if not _bump(match.id, match.version, values):
        db.session.rollback()
        return _error("The table changed. Syncing with the latest position.", 409, resync=True)

    db.session.add(GameShot(
        match_id=match.id, seq=seq, user_id=g.me_id,
        angle=float(angle), power=min(float(power), 1.0),
        foul=result["foul"], pocketed=",".join(str(i) for i in result["pocketed"]),
    ))
    db.session.commit()
    db.session.expire_all()

    return jsonify(_match_view(db.session.get(GameMatch, match_id), slot, since_shot=seq - 1))


@games_bp.route("/games/matches/<int:match_id>/leave", methods=["POST"])
@login_required
def leave_match(match_id):
    """Leaving an active match forfeits it. Leaving before it starts just cancels it."""
    match, slot = _participant_match(match_id)

    if not match:
        return _error("Match not found", 404)

    if match.status not in ("waiting", "active"):
        return _error("This match is already over", 409)

    users = _match_users(match)
    my_name = users[g.me_id].full_name

    if match.status == "waiting":
        done = _finish(match, None, f"{my_name} left before the match started")
    else:
        done = _finish(match, 3 - slot, f"{my_name} left the match")

    db.session.commit()

    if not done:
        return _error("The match just ended", 409)

    db.session.expire_all()

    return jsonify(_match_view(db.session.get(GameMatch, match_id), slot))


@games_bp.route("/games/matches/<int:match_id>/claim", methods=["POST"])
@login_required
def claim_win(match_id):
    """Win by forfeit, but only after the opponent has really been gone a while."""
    match, slot = _participant_match(match_id)

    if not match:
        return _error("Match not found", 404)

    if match.status != "active":
        return _error("This match is not in progress", 409)

    view = _match_view(match, slot)

    if not view["can_claim"]:
        return _error("Your opponent hasn't been away long enough to claim the match", 409)

    users = _match_users(match)
    other_name = users[match.player2_id if slot == 1 else match.player1_id].full_name

    if not _finish(match, slot, f"{other_name} disconnected and didn't come back"):
        db.session.rollback()
        return _error("The match just changed", 409)

    db.session.commit()
    db.session.expire_all()

    return jsonify(_match_view(db.session.get(GameMatch, match_id), slot))


@games_bp.route("/games/matches/<int:match_id>/rematch", methods=["POST"])
@login_required
def rematch(match_id):
    _housekeeping()

    match, slot = _participant_match(match_id)

    if not match:
        return _error("Match not found", 404)

    if match.status not in ("completed", "cancelled"):
        return _error("Finish this match first", 409)

    other_id = match.player2_id if slot == 1 else match.player1_id
    opponent = db.session.get(User, other_id)

    # they already asked for a rematch: accept it instead of asking twice
    waiting = GameChallenge.query.filter_by(
        challenger_id=other_id, opponent_id=g.me_id,
        status="pending", rematch_of_match_id=match.id,
    ).first()

    if waiting:
        return accept_challenge(waiting.id)

    return _create_challenge(opponent, rematch_of=match.id)
