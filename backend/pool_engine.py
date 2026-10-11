"""Authoritative 8-ball pool: physics and rules.

This module is the only place where a shot is turned into a result. The browser
only sends an aim angle and a power; the server runs the physics, applies the
rules, and decides every pocketed ball, foul, turn change, and winner.

Table units: 1000 x 500, ball radius 12.5. Ball ids: 0 = cue ball, 1-7 solids,
8 = the black ball, 9-15 stripes.

Rules used (simple "bar" 8-ball, same for both players):
  * Player 1 breaks. The table is open until a player legally pockets balls.
  * A shot is legal when the cue ball first touches one of your own balls
    (any ball but the 8 while the table is open, and the 8 only after you have
    cleared your group), and then a ball is pocketed or touches a rail.
  * Pocket a legal ball and you shoot again; otherwise the turn passes.
  * Any foul (cue ball pocketed, wrong or no ball hit, no rail) gives your
    opponent the cue ball anywhere on the table (ball in hand).
  * Break: needs a pocketed ball or four balls to a rail, else it is a foul.
    A ball pocketed on the break does not choose groups. The 8 on the break is
    put back on the foot spot.
  * Pocket the 8 after clearing your group, without a foul: you win.
    Pocket it any other way (too early, with a foul): you lose.
  * Pockets are not called: any pocket counts.
"""
import math
import random

W, H, R = 1000.0, 500.0, 12.5

MAX_SPEED = 2000.0          # units per second at full power
DECEL = 300.0               # rolling friction, units per second squared
STOP_SPEED = 5.0
RAIL_RESTITUTION = 0.78
BALL_RESTITUTION = 0.96
DT = 1.0 / 240.0
FPS = 30
FRAME_EVERY = int(round(1.0 / DT / FPS))      # 8 steps per recorded frame
MAX_SIM_SECONDS = 20.0

CORNER_R = 30.0
SIDE_R = 24.0
POCKETS = [
    (0.0, 0.0, CORNER_R), (W, 0.0, CORNER_R),
    (0.0, H, CORNER_R), (W, H, CORNER_R),
    (W / 2, 0.0, SIDE_R), (W / 2, H, SIDE_R),
]

HEAD_SPOT = (W * 0.25, H / 2)
FOOT_SPOT = (W * 0.75, H / 2)

SOLIDS = tuple(range(1, 8))
STRIPES = tuple(range(9, 16))
OFF_TABLE = -999.0


# ------------------------------------------------------------------ setup

def new_balls(seed):
    """A fresh rack: cue ball on the head spot, 8 in the middle of the triangle,
    one solid and one stripe in the back corners, the rest shuffled."""
    rng = random.Random(seed)

    spacing = 2 * R * 1.002
    row_gap = R * math.sqrt(3) * 1.002

    spots = []
    for row in range(5):
        for k in range(row + 1):
            spots.append((FOOT_SPOT[0] + row * row_gap,
                          H / 2 + (k - row / 2.0) * spacing))

    corner_solid = rng.choice(SOLIDS)
    corner_stripe = rng.choice(STRIPES)
    corners = [corner_solid, corner_stripe]
    rng.shuffle(corners)

    rest = [i for i in range(1, 16) if i not in (8, corner_solid, corner_stripe)]
    rng.shuffle(rest)

    order = [None] * 15
    order[4] = 8                      # middle of the third row
    order[10], order[14] = corners    # back corners
    it = iter(rest)
    for i in range(15):
        if order[i] is None:
            order[i] = next(it)

    balls = [{"id": 0, "x": HEAD_SPOT[0], "y": HEAD_SPOT[1], "pocketed": False}]
    for ball_id, (x, y) in zip(order, spots):
        balls.append({"id": ball_id, "x": round(x, 2), "y": round(y, 2), "pocketed": False})

    balls.sort(key=lambda b: b["id"])
    return balls


def new_state(seed, breaker_slot=1):
    return {
        "balls": new_balls(seed),
        "turn": breaker_slot,
        "groups": {"1": None, "2": None},
        "table_open": True,
        "ball_in_hand": False,
        "breaking": True,
        "shot_seq": 0,
        "message": "Break the rack to start.",
        "stats": {
            "1": {"shots": 0, "pocketed": 0, "fouls": 0},
            "2": {"shots": 0, "pocketed": 0, "fouls": 0},
        },
    }


def group_of(ball_id):
    if ball_id in SOLIDS:
        return "solids"
    if ball_id in STRIPES:
        return "stripes"
    return None


def remaining(state, group):
    """Balls of a group still on the table."""
    ids = SOLIDS if group == "solids" else STRIPES
    return [b["id"] for b in state["balls"] if b["id"] in ids and not b["pocketed"]]


# ------------------------------------------------------------- placement

def valid_cue_placement(balls, x, y):
    """Is (x, y) a legal place for the cue ball?"""
    if not (isinstance(x, (int, float)) and isinstance(y, (int, float))):
        return False

    if math.isnan(x) or math.isnan(y) or math.isinf(x) or math.isinf(y):
        return False

    if x < R or x > W - R or y < R or y > H - R:
        return False

    for px, py, pr in POCKETS:
        if math.hypot(x - px, y - py) < pr + 2:
            return False

    for b in balls:
        if b["id"] != 0 and not b["pocketed"]:
            if math.hypot(x - b["x"], y - b["y"]) < 2 * R + 0.5:
                return False

    return True


def free_spot_near(balls, x, y):
    """Closest free place for the 8 when it has to be put back."""
    step = 0
    while step < 40:
        for dx in (0, 1, -1):
            cx = x + dx * step * R * 2.1
            if cx > W - R or cx < R:
                continue
            if all(
                b["pocketed"] or b["id"] == 8 or math.hypot(cx - b["x"], y - b["y"]) >= 2 * R + 0.5
                for b in balls
            ):
                return cx, y
        step += 1
    return x, y


# --------------------------------------------------------------- physics

class Sim:
    """Everything the rules need to know about one shot."""

    def __init__(self):
        self.frames = []
        self.events = []
        self.first_contact = None
        self.pocketed = []           # object-ball ids in the order they dropped
        self.cue_pocketed = False
        self.rail_after_contact = False
        self.object_rail_hits = set()
        self.final = {}              # id -> (x, y, pocketed)
        self.seconds = 0.0


def simulate(balls, angle, power, cue_pos=None):
    """Run one shot. `balls` is the resting state; it is not modified."""
    n = 16
    x = [OFF_TABLE] * n
    y = [OFF_TABLE] * n
    vx = [0.0] * n
    vy = [0.0] * n
    alive = [False] * n

    for b in balls:
        i = b["id"]
        if not b["pocketed"]:
            x[i], y[i] = b["x"], b["y"]
            alive[i] = True

    if cue_pos is not None:
        x[0], y[0] = float(cue_pos[0]), float(cue_pos[1])
        alive[0] = True

    power = max(0.02, min(1.0, float(power)))
    speed = MAX_SPEED * power
    vx[0] = speed * math.cos(angle)
    vy[0] = speed * math.sin(angle)

    started_alive = [i for i in range(n) if alive[i]]
    sim = Sim()

    def snapshot():
        row = []
        for i in range(n):
            if i in started_alive:
                row.append(round(x[i], 1))
                row.append(round(y[i], 1))
            else:
                row.append(OFF_TABLE)
                row.append(OFF_TABLE)
        return row

    sim.frames.append(snapshot())

    max_steps = int(MAX_SIM_SECONDS / DT)
    two_r = 2 * R
    two_r_sq = two_r * two_r

    for step in range(1, max_steps + 1):
        t = step * DT
        moving = False

        # move + friction
        for i in started_alive:
            if not alive[i]:
                continue

            if vx[i] != 0.0 or vy[i] != 0.0:
                x[i] += vx[i] * DT
                y[i] += vy[i] * DT

                s = math.hypot(vx[i], vy[i])
                s2 = s - DECEL * DT

                if s2 <= STOP_SPEED:
                    vx[i] = vy[i] = 0.0
                else:
                    k = s2 / s
                    vx[i] *= k
                    vy[i] *= k
                    moving = True

        # pockets
        for i in started_alive:
            if not alive[i]:
                continue

            for pi, (px, py, pr) in enumerate(POCKETS):
                if math.hypot(x[i] - px, y[i] - py) < pr:
                    alive[i] = False
                    vx[i] = vy[i] = 0.0
                    x[i], y[i] = px, py             # rests in the pocket for the replay

                    if i == 0:
                        sim.cue_pocketed = True
                    else:
                        sim.pocketed.append(i)

                    sim.events.append({"t": round(t, 3), "type": "pocket", "ball": i, "pocket": pi})
                    break

        # rails
        for i in started_alive:
            if not alive[i]:
                continue

            bounced = False

            if x[i] < R:
                x[i] = R
                vx[i] = abs(vx[i]) * RAIL_RESTITUTION
                bounced = True
            elif x[i] > W - R:
                x[i] = W - R
                vx[i] = -abs(vx[i]) * RAIL_RESTITUTION
                bounced = True

            if y[i] < R:
                y[i] = R
                vy[i] = abs(vy[i]) * RAIL_RESTITUTION
                bounced = True
            elif y[i] > H - R:
                y[i] = H - R
                vy[i] = -abs(vy[i]) * RAIL_RESTITUTION
                bounced = True

            if bounced:
                if sim.first_contact is not None:
                    sim.rail_after_contact = True

                if i != 0:
                    sim.object_rail_hits.add(i)

                if len(sim.events) < 250:
                    sim.events.append({"t": round(t, 3), "type": "rail", "ball": i})

        # ball against ball
        live = [i for i in started_alive if alive[i]]

        for a_idx in range(len(live)):
            a = live[a_idx]

            for b_idx in range(a_idx + 1, len(live)):
                b = live[b_idx]

                dx = x[b] - x[a]
                dy = y[b] - y[a]
                d2 = dx * dx + dy * dy

                if d2 >= two_r_sq or d2 == 0.0:
                    continue

                d = math.sqrt(d2)
                nx, ny = dx / d, dy / d

                rel = (vx[a] - vx[b]) * nx + (vy[a] - vy[b]) * ny

                if rel > 0.0:
                    j = (1.0 + BALL_RESTITUTION) * rel / 2.0
                    vx[a] -= j * nx
                    vy[a] -= j * ny
                    vx[b] += j * nx
                    vy[b] += j * ny

                    if sim.first_contact is None and (a == 0 or b == 0):
                        sim.first_contact = b if a == 0 else a

                    if len(sim.events) < 250:
                        sim.events.append({"t": round(t, 3), "type": "hit", "a": a, "b": b})

                overlap = (two_r - d) / 2.0
                x[a] -= overlap * nx
                y[a] -= overlap * ny
                x[b] += overlap * nx
                y[b] += overlap * ny

        if step % FRAME_EVERY == 0:
            sim.frames.append(snapshot())

        if not moving and not any(
            (vx[i] != 0.0 or vy[i] != 0.0) for i in started_alive if alive[i]
        ):
            break

    sim.seconds = round(step * DT, 3)

    last = snapshot()
    if sim.frames[-1] != last:
        sim.frames.append(last)

    for i in range(n):
        sim.final[i] = (round(x[i], 2), round(y[i], 2), not alive[i])

    return sim


# ----------------------------------------------------------------- rules

def _label(ball_id):
    return "the 8-ball" if ball_id == 8 else f"ball {ball_id}"


def resolve_shot(state, slot, sim, names):
    """Apply the rules to a finished simulation. Mutates `state`.

    `names` maps slot (1 or 2) to a display name. Returns a summary dict that
    includes `winner_slot` / `win_reason` when the match is over."""
    me, other = str(slot), str(3 - slot)
    my_name, other_name = names[slot], names[3 - slot]

    breaking = state["breaking"]
    group = state["groups"][me]

    # what could I legally hit first, and was my group already cleared?
    cleared_before = group is not None and not remaining(state, group)

    if group is None:
        legal_first = {b["id"] for b in state["balls"]
                       if b["id"] not in (0, 8) and not b["pocketed"]}
        if breaking:
            legal_first.add(8)
    elif cleared_before:
        legal_first = {8}
    else:
        legal_first = set(remaining(state, group))

    objects_pocketed = list(sim.pocketed)

    # ---- fouls
    fouls = []

    if sim.cue_pocketed:
        fouls.append("the cue ball was pocketed")

    if sim.first_contact is None:
        fouls.append("the cue ball hit nothing")
    elif sim.first_contact not in legal_first:
        fouls.append("the wrong ball was hit first")

    if not fouls:
        if breaking:
            if not objects_pocketed and len(sim.object_rail_hits) < 4:
                fouls.append("illegal break (needs a pocketed ball or four balls to a rail)")
        elif not objects_pocketed and not sim.rail_after_contact:
            fouls.append("no ball reached a rail")

    foul = bool(fouls)

    # ---- update the board with what actually happened
    for b in state["balls"]:
        x, y, pocketed = sim.final[b["id"]]
        if b["id"] == 0 and sim.cue_pocketed:
            b["pocketed"] = True
            b["x"], b["y"] = HEAD_SPOT
        else:
            b["x"], b["y"], b["pocketed"] = x, y, pocketed

    # the cue ball is never "gone": after a scratch the next player places it
    cue = state["balls"][0]
    cue["pocketed"] = False

    state["stats"][me]["shots"] += 1

    result = {
        "pocketed": objects_pocketed,
        "cue_pocketed": sim.cue_pocketed,
        "foul": foul,
        "foul_reasons": fouls,
        "winner_slot": None,
        "win_reason": None,
    }

    # ---- the 8-ball decides the game
    if 8 in objects_pocketed:
        if breaking:
            spot = free_spot_near(state["balls"], FOOT_SPOT[0], FOOT_SPOT[1])
            eight = state["balls"][8]
            eight["x"], eight["y"], eight["pocketed"] = spot[0], spot[1], False
            objects_pocketed.remove(8)
            result["pocketed"] = objects_pocketed
            result["respotted_eight"] = True
        elif cleared_before and not foul:
            result["winner_slot"] = slot
            result["win_reason"] = f"{my_name} pocketed the 8-ball"
        else:
            result["winner_slot"] = 3 - slot
            if foul:
                result["win_reason"] = f"{my_name} pocketed the 8-ball and fouled"
            else:
                result["win_reason"] = f"{my_name} pocketed the 8-ball too early"

    state["balls"][0]["pocketed"] = False

    # ---- groups, turn, messages
    if result["winner_slot"]:
        state["breaking"] = False
        state["ball_in_hand"] = False
        state["shot_seq"] += 1
        state["message"] = result["win_reason"] + "."
        state["stats"][me]["pocketed"] += len([i for i in objects_pocketed if i != 8])
        result["continue_turn"] = False
        return result

    if not foul and not breaking and state["table_open"] and objects_pocketed:
        kinds = {group_of(i) for i in objects_pocketed}
        if len(kinds) == 1:
            mine = kinds.pop()
            state["groups"][me] = mine
            state["groups"][other] = "stripes" if mine == "solids" else "solids"
            state["table_open"] = False
            result["assigned"] = mine

    my_group = state["groups"][me]

    if foul:
        keeps_turn = False
    elif breaking:
        keeps_turn = bool(objects_pocketed)
    elif state["table_open"]:
        keeps_turn = bool(objects_pocketed)
    else:
        keeps_turn = any(group_of(i) == my_group for i in objects_pocketed)

    state["stats"][me]["pocketed"] += len(objects_pocketed)

    if foul:
        state["stats"][me]["fouls"] += 1
        state["turn"] = 3 - slot
        state["ball_in_hand"] = True
    elif keeps_turn:
        state["turn"] = slot
        state["ball_in_hand"] = False
    else:
        state["turn"] = 3 - slot
        state["ball_in_hand"] = False

    state["breaking"] = False
    state["shot_seq"] += 1

    # ---- the sentence players see
    parts = []

    if result.get("assigned"):
        parts.append(f"{my_name} is {result['assigned']}, {other_name} is {state['groups'][other]}.")

    if objects_pocketed:
        parts.append(f"{my_name} pocketed {', '.join(_label(i) for i in objects_pocketed)}.")

    if result.get("respotted_eight"):
        parts.append("The 8-ball was pocketed on the break and put back on the table.")

    if foul:
        parts.append(f"Foul: {fouls[0]}. {names[state['turn']]} has the cue ball in hand.")
    elif keeps_turn:
        parts.append(f"{my_name} shoots again.")
    else:
        parts.append(f"{names[state['turn']]}'s turn.")

    if not parts:
        parts.append(f"{names[state['turn']]}'s turn.")

    state["message"] = " ".join(parts)
    result["continue_turn"] = state["turn"] == slot

    return result
