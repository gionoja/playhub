/* =====================================================================
   PLAYHUB 8-ball pool (the Snooker card): lobby, challenges, the table,
   shot replay, and the win / lose screens.

   The server owns the game. This file only:
     * asks the server for the table and draws it,
     * sends an aim angle and a power when it is your turn,
     * replays the shot the server calculated, so both players see the same.
   ===================================================================== */

const POOL = { W: 1000, H: 500, R: 12.5, RAIL: 34 };

const POOL_POCKETS = [
    [0, 0, 30], [1000, 0, 30], [0, 500, 30], [1000, 500, 30], [500, 0, 24], [500, 500, 24]
];

const POOL_COLORS = {
    1: "#f4c20d", 2: "#1565c0", 3: "#d32f2f", 4: "#6a1b9a",
    5: "#ef6c00", 6: "#2e7d32", 7: "#8d1c1c", 8: "#111111"
};

const POOL_ICONS = {
    back: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
    trophy: '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>',
    flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/>',
    wifiOff: '<path d="M12 20h.01"/><path d="M8.5 16.429a5 5 0 0 1 7 0"/><path d="M5 12.859a10 10 0 0 1 5.17-2.69"/><path d="M19 12.859a10 10 0 0 0-2.007-1.523"/><path d="M2 8.82a15 15 0 0 1 4.177-2.643"/><path d="M22 8.82a15 15 0 0 0-11.288-3.764"/><path d="m2 2 20 20"/>',
    target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    minus: '<path d="M5 12h14"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>'
};

function poolIcon(name, size) {
    const t = document.createElement("template");
    t.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size +
        '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        POOL_ICONS[name] + "</svg>";
    return t.content.firstChild;
}

const pool = {
    // lobby + challenges
    friends: [],
    incoming: [],
    outgoing: [],
    activeMatch: null,
    shownIncoming: new Set(),
    waiting: null,              // { id, name, rematch }
    pollTimer: null,
    pollBusy: false,

    // match
    matchId: null,
    open: false,
    match: null,                // last state shown
    latest: null,               // newest state received (may be waiting for a replay)
    playedSeq: 0,
    failures: 0,
    matchTimer: null,
    sending: false,
    resultShown: false,
    rematchPending: false,

    // table + input
    canvas: null,
    ctx: null,
    scale: 1,
    dpr: 1,
    balls: [],                  // what is drawn: {id, x, y, pocketed, scale}
    aim: 0,
    power: 0.6,
    mode: "aim",
    cue: null,                  // chosen cue ball spot when you have it in hand
    dragging: false,
    anim: null,
    strike: null,
    raf: 0,
    confetti: null
};


/* ------------------------- small helpers -------------------------- */

const poolEl = id => document.getElementById(id);

function poolBallColor(id) {
    return POOL_COLORS[id > 8 ? id - 8 : id];
}

function poolClock(seconds) {
    if (seconds == null) return "-";
    return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
}


/* ============================ LIFECYCLE =========================== */

function onGamesOpened() {

    pollGames();

    clearInterval(pool.pollTimer);
    pool.pollTimer = setInterval(() => {
        if (!document.hidden) pollGames();
    }, 3000);
}

function onGamesClosed() {

    clearInterval(pool.pollTimer);
    pool.pollTimer = null;

    closePoolView(true);

    ["poolLobbyModal", "poolWaitModal", "poolChallengeModal", "poolRulesModal"].forEach(closeModal);

    Object.assign(pool, {
        friends: [], incoming: [], outgoing: [], activeMatch: null, waiting: null,
        match: null, latest: null, matchId: null, resultShown: false, rematchPending: false
    });

    pool.shownIncoming.clear();

    renderResumePill();
    renderGameMatches();
}


/* ======================== POLLING (invitations) ==================== */

async function pollGames() {

    if (pool.pollBusy) return;
    pool.pollBusy = true;

    try {
        const data = await api("/games/active");

        pool.incoming = data.incoming;
        pool.outgoing = data.outgoing;
        pool.activeMatch = data.match;

        handleGamePoll();

    } catch (error) {
        // background check; stay quiet
    }

    pool.pollBusy = false;
}

function handleGamePoll() {

    // someone challenged you
    pool.incoming.forEach(ch => {
        if (!pool.shownIncoming.has(ch.id)) {
            pool.shownIncoming.add(ch.id);
            showToast(ch.user.full_name + (ch.rematch ? " wants a rematch" : " challenged you to 8-Ball Pool"));
            if (!pool.open || ch.rematch) showIncomingChallenge(ch);
        }
    });

    // an answer to a challenge you sent
    if (pool.waiting) {
        const mine = pool.outgoing.find(c => c.id === pool.waiting.id);

        if (mine && mine.status !== "pending") {
            const w = pool.waiting;
            pool.waiting = null;
            pool.rematchPending = false;

            if (mine.status === "accepted" && mine.match_id) {
                closeModal("poolWaitModal");
                closeModal("poolLobbyModal");
                openPoolMatch(mine.match_id);
            } else {
                const text = {
                    declined: w.name + " declined the challenge",
                    expired: "The challenge expired. " + w.name + " didn't answer in time.",
                    cancelled: "The challenge was cancelled"
                }[mine.status] || "The challenge ended";

                renderPoolWait(text, true);
                if (pool.open) { showToast(text); renderPoolResult(); }
            }
        }
    }

    updateBadges();
    renderNotifications();
    renderGameMatches();
    renderResumePill();

    // a rematch request changes the buttons on the result screen
    if (pool.open && pool.resultShown) renderPoolResult();
}

function pendingChallengeCount() {
    return pool.incoming.length;
}

// Invitations also appear in the bell
function appendChallengeNotifications(list) {

    pool.incoming.forEach(ch => {

        const item = el("div", "notice-item unread");
        item.append(avatarNode(ch.user));

        const text = el("div", "notice-text");
        const line = el("div");
        line.append(el("strong", null, ch.user.full_name),
            document.createTextNode(ch.rematch ? " wants a rematch in 8-Ball Pool" : " challenged you to 8-Ball Pool"));
        text.append(line);

        const actions = el("div", "notice-actions");
        actions.append(
            actionButton("Accept", "primary", () => acceptChallenge(ch), "check"),
            actionButton("Decline", "ghost", () => declineChallenge(ch))
        );
        text.append(actions);

        item.append(text);
        list.append(item);
    });

    return pool.incoming.length;
}


/* ============================== LOBBY ============================= */

function poolTableArt() {

    const t = document.createElement("template");
    t.innerHTML =
        '<svg class="pool-art" viewBox="0 0 220 120" role="img" aria-label="Pool table">' +
        '<rect x="2" y="2" width="216" height="116" rx="14" fill="#5b3a22"/>' +
        '<rect x="12" y="12" width="196" height="96" rx="8" fill="#0f7a4a"/>' +
        '<circle cx="14" cy="14" r="8" fill="#0b0b0b"/><circle cx="206" cy="14" r="8" fill="#0b0b0b"/>' +
        '<circle cx="14" cy="106" r="8" fill="#0b0b0b"/><circle cx="206" cy="106" r="8" fill="#0b0b0b"/>' +
        '<circle cx="110" cy="12" r="7" fill="#0b0b0b"/><circle cx="110" cy="108" r="7" fill="#0b0b0b"/>' +
        '<circle cx="62" cy="60" r="6" fill="#fff"/>' +
        '<circle cx="150" cy="60" r="6" fill="#f4c20d"/><circle cx="160" cy="54" r="6" fill="#1565c0"/>' +
        '<circle cx="160" cy="66" r="6" fill="#d32f2f"/><circle cx="170" cy="60" r="6" fill="#111"/>' +
        '<line x1="20" y1="60" x2="52" y2="60" stroke="#e8d3a2" stroke-width="3" stroke-linecap="round"/></svg>';

    return t.content.firstChild;
}

function openPoolLobby() {

    poolEl("poolLobbyModal").classList.remove("hidden");

    renderPoolIntro();
}

function renderPoolIntro() {

    const body = poolEl("poolLobbyBody");
    body.replaceChildren();

    document.getElementById("poolLobbyTitle").textContent = "Snooker";

    const hero = el("div", "pool-hero");
    hero.append(poolTableArt(),
        el("h3", null, "8-Ball Pool"),
        el("p", null, "Challenge a friend to a two-player match. Pot your group of balls, then the black 8-ball to win."));
    body.append(hero);

    const note = el("p", "pool-note");
    note.append(poolIcon("target", 16),
        document.createTextNode(" Free match. No money is involved while PlayHub is in demo mode."));
    body.append(note);

    if (pool.activeMatch) {
        body.append(el("p", "form-msg info", "You have a match with " +
            pool.activeMatch.opponent.full_name + " in progress."));

        const resume = actionButton("Return to match", "primary", () => {
            closeModal("poolLobbyModal");
            openPoolMatch(pool.activeMatch.id);
        });
        resume.classList.add("pool-wide");
        body.append(resume);
        return;
    }

    const play = actionButton("Play", "primary", poolPlay);
    play.classList.add("pool-wide");

    const rules = actionButton("How to play", "ghost", openPoolRules);
    rules.classList.add("pool-wide");

    body.append(play, rules);
}

function openPoolRules(afterClose) {

    poolEl("poolRulesModal").classList.remove("hidden");
    pool.afterRules = typeof afterClose === "function" ? afterClose : null;
}

function closePoolRules() {

    localStorage.setItem("playhub_pool_rules_seen", "1");
    closeModal("poolRulesModal");

    const next = pool.afterRules;
    pool.afterRules = null;

    if (next) next();
}

function poolPlay() {

    // new players read the rules once before their first match
    if (!localStorage.getItem("playhub_pool_rules_seen")) {
        openPoolRules(showPoolFriends);
        return;
    }

    showPoolFriends();
}

async function showPoolFriends() {

    poolEl("poolLobbyModal").classList.remove("hidden");

    const body = poolEl("poolLobbyBody");
    document.getElementById("poolLobbyTitle").textContent = "Choose a friend";

    body.replaceChildren(skeletonRows(3));

    try {
        pool.friends = await api("/games/pool/friends");
    } catch (error) {
        body.replaceChildren(stateBlock("alert", "Couldn't load your friends", error.message, showPoolFriends));
        return;
    }

    renderPoolFriends();
}

function renderPoolFriends() {

    const body = poolEl("poolLobbyBody");
    body.replaceChildren();

    if (pool.friends.length === 0) {
        const block = stateBlock("users", "You need friends to play",
            "Add friends first, then you can challenge them to a match.");
        const go = actionButton("Find friends", "primary", () => {
            closeModal("poolLobbyModal");
            showScreen("friends");
        });
        go.style.marginTop = "16px";
        block.append(go);
        body.append(block);
        return;
    }

    if (!pool.friends.some(f => f.online)) {
        body.append(el("p", "form-msg info",
            "None of your friends are online right now. You can still invite one. " +
            "They'll see your challenge when they open PlayHub (it lasts 10 minutes)."));
    }

    const list = el("div", "people-list");

    pool.friends.forEach(f => {

        const row = el("div", "person-row");

        const wrap = el("div", "avatar-wrap");
        wrap.append(avatarNode(f));
        if (f.online) wrap.append(el("span", "online-dot"));

        const info = el("div", "person-info");
        const status = f.busy ? "In a match" : (f.online ? "Online" : "Offline");
        info.append(el("strong", null, f.full_name), el("small", null, "@" + f.username + "  \u00b7  " + status));

        const actions = el("div", "person-actions");

        let label = f.online ? "Challenge" : "Invite";
        let disabled = f.busy;

        if (f.challenge === "sent") { label = "Invited"; disabled = true; }
        if (f.challenge === "received") { label = "Challenged you"; disabled = true; }

        actions.append(actionButton(label, "primary", () => challengeFriend(f), "target", disabled));

        row.append(wrap, info, actions);
        list.append(row);
    });

    body.append(list);
}

async function challengeFriend(friend) {

    try {
        const ch = await api("/games/pool/challenges", {
            method: "POST",
            body: { username: friend.username }
        });

        pool.waiting = { id: ch.id, name: friend.full_name, rematch: false };
        pool.outgoing = [ch].concat(pool.outgoing.filter(c => c.id !== ch.id));

        closeModal("poolLobbyModal");
        renderPoolWait();

    } catch (error) {
        showToast(error.message);
        showPoolFriends();
    }
}

function renderPoolWait(endedText, ended) {

    const modal = poolEl("poolWaitModal");
    const body = poolEl("poolWaitBody");

    modal.classList.remove("hidden");
    body.replaceChildren();

    const w = pool.waiting;

    const icon = el("div", "verify-icon" + (ended ? " bad" : ""));
    icon.append(poolIcon(ended ? "flag" : "clock", 30));

    body.append(icon,
        el("h3", null, ended ? "Challenge ended" : "Waiting for opponent"),
        el("p", "verify-text", ended
            ? endedText
            : "Challenge sent to " + w.name + ". The match starts when they accept."));

    if (!ended) {
        body.append(el("div", "pool-chip", "Waiting for opponent"));
        const cancel = actionButton("Cancel challenge", "ghost", poolCancelChallenge);
        cancel.classList.add("pool-wide");
        body.append(cancel);
    } else {
        const again = actionButton("Back to friends", "primary", () => {
            closeModal("poolWaitModal");
            showPoolFriends();
        });
        again.classList.add("pool-wide");
        body.append(again);
    }
}

async function poolCancelChallenge() {

    if (!pool.waiting) return;

    const id = pool.waiting.id;
    pool.waiting = null;

    try {
        await api("/games/pool/challenges/" + id + "/cancel", { method: "POST" });
    } catch (error) {
        // it may already have been answered; the next poll shows the truth
    }

    closeModal("poolWaitModal");
    pollGames();
}

function showIncomingChallenge(ch) {

    const modal = poolEl("poolChallengeModal");
    const body = poolEl("poolChallengeBody");

    body.replaceChildren();

    const who = avatarNode(ch.user, "large");

    body.append(who,
        el("h3", null, ch.user.full_name),
        el("p", "verify-text", ch.rematch
            ? "wants a rematch in 8-Ball Pool."
            : "challenges you to a game of 8-Ball Pool."),
        el("div", "pool-chip", "Challenge received"));

    const row = el("div", "pool-two");
    row.append(
        actionButton("Accept", "primary", () => acceptChallenge(ch), "check"),
        actionButton("Decline", "ghost", () => declineChallenge(ch))
    );
    body.append(row);

    modal.classList.remove("hidden");
}

async function acceptChallenge(ch) {

    try {
        const result = await api("/games/pool/challenges/" + ch.id + "/accept", { method: "POST" });

        closeModal("poolChallengeModal");
        closeModal("notificationModal");
        closeModal("poolLobbyModal");

        pool.incoming = pool.incoming.filter(c => c.id !== ch.id);

        openPoolMatch(result.match_id);

    } catch (error) {
        showToast(error.message);
        closeModal("poolChallengeModal");
        pollGames();
    }
}

async function declineChallenge(ch) {

    try {
        await api("/games/pool/challenges/" + ch.id + "/decline", { method: "POST" });
        showToast("Challenge declined");
    } catch (error) {
        showToast(error.message);
    }

    pool.incoming = pool.incoming.filter(c => c.id !== ch.id);

    closeModal("poolChallengeModal");
    pollGames();
    handleGamePoll();
}

// The "Available matches" box on the Games screen
function renderGameMatches() {

    const box = poolEl("gameMatchesList");
    const empty = poolEl("gameMatchesEmpty");

    if (!box || !empty) return;

    box.replaceChildren();

    const cards = [];

    if (pool.activeMatch) {
        const card = el("div", "person-row");
        card.append(avatarNode(pool.activeMatch.opponent));

        const info = el("div", "person-info");
        info.append(el("strong", null, "8-Ball Pool vs " + pool.activeMatch.opponent.full_name),
            el("small", null, pool.activeMatch.status === "waiting" ? "Waiting for players" : "Match in progress"));

        const actions = el("div", "person-actions");
        actions.append(actionButton("Return", "primary", () => openPoolMatch(pool.activeMatch.id)));

        card.append(info, actions);
        cards.push(card);
    }

    pool.incoming.forEach(ch => {
        const card = el("div", "person-row");
        card.append(avatarNode(ch.user));

        const info = el("div", "person-info");
        info.append(el("strong", null, ch.user.full_name), el("small", null, "Challenge received"));

        const actions = el("div", "person-actions");
        actions.append(
            actionButton("Accept", "primary", () => acceptChallenge(ch)),
            actionButton("Decline", "ghost", () => declineChallenge(ch))
        );

        card.append(info, actions);
        cards.push(card);
    });

    pool.outgoing.filter(c => c.status === "pending").forEach(ch => {
        const card = el("div", "person-row");
        card.append(avatarNode(ch.user));

        const info = el("div", "person-info");
        info.append(el("strong", null, ch.user.full_name), el("small", null, "Waiting for opponent"));

        const actions = el("div", "person-actions");
        actions.append(actionButton("Cancel", "ghost", async () => {
            try { await api("/games/pool/challenges/" + ch.id + "/cancel", { method: "POST" }); } catch (e) { /* already answered */ }
            if (pool.waiting && pool.waiting.id === ch.id) pool.waiting = null;
            closeModal("poolWaitModal");
            pollGames();
        }));

        card.append(info, actions);
        cards.push(card);
    });

    cards.forEach(c => box.append(c));

    empty.classList.toggle("hidden", cards.length > 0);
}

function renderResumePill() {

    const pill = poolEl("poolResumePill");

    if (!pill) return;

    const show = !!pool.activeMatch && !pool.open;

    pill.classList.toggle("hidden", !show);

    if (show) {
        pill.querySelector("span").textContent =
            "Match with " + pool.activeMatch.opponent.full_name;
    }
}


/* ============================== THE MATCH ========================= */

async function openPoolMatch(id) {

    closeModal("poolLobbyModal");
    closeModal("poolWaitModal");
    closeModal("poolChallengeModal");
    closeModal("notificationModal");

    clearInterval(pool.matchTimer);

    Object.assign(pool, {
        matchId: id, open: true, match: null, latest: null, anim: null, strike: null,
        playedSeq: 0, failures: 0, sending: false, resultShown: false,
        rematchPending: false, cue: null, mode: "aim", dragging: false
    });

    poolEl("poolView").classList.remove("hidden");
    poolEl("poolResult").classList.add("hidden");
    poolEl("poolConfirm").classList.add("hidden");

    renderResumePill();
    setupPoolCanvas();
    renderPoolLoading();

    document.addEventListener("keydown", poolKeys);

    cancelAnimationFrame(pool.raf);
    pool.raf = requestAnimationFrame(poolLoop);

    await loadPoolMatch();

    pool.matchTimer = setInterval(() => {
        if (!document.hidden) pollMatch();
    }, 1000);
}

async function loadPoolMatch() {

    try {
        // a huge "shot" number means: just the table, no replay (also used when rejoining)
        const view = await api("/games/matches/" + pool.matchId + "?shot=999999999");

        pool.playedSeq = view.shot_seq;
        applyMatch(view);

    } catch (error) {
        poolEl("poolMessage").replaceChildren();
        poolEl("poolMessage").append(
            stateBlock("alert", "Couldn't open the match", error.message, loadPoolMatch));
    }
}

function renderPoolLoading() {

    poolEl("poolStatus").textContent = "Loading match...";
    poolEl("poolConn").textContent = "";
    poolEl("poolPlayers").replaceChildren();
    poolEl("poolMessage").replaceChildren(document.createTextNode("Getting the table ready..."));
    poolEl("poolOverlay").classList.add("hidden");
}

async function pollMatch() {

    if (!pool.open || pool.sending) return;

    const id = pool.matchId;

    try {
        const view = await api("/games/matches/" + id + "?shot=" + pool.playedSeq);

        if (!pool.open || pool.matchId !== id) return;

        pool.failures = 0;
        receivePoolView(view);

    } catch (error) {

        if (error.status === 404) {
            closePoolView(true);
            showToast("That match is no longer available");
            return;
        }

        pool.failures++;
        renderPoolConn();
    }
}

// Everything the server sends goes through here, whoever took the shot
function receivePoolView(view) {

    if (view.last_shot && view.last_shot.seq > pool.playedSeq) {
        startReplay(view, 0);
        return;
    }

    if (pool.anim) {
        pool.latest = view;              // show it when the replay ends
        return;
    }

    if (!pool.match || view.version >= pool.match.version) applyMatch(view);
    else renderPoolConn();
}

function startReplay(view, delayMs) {

    pool.playedSeq = view.last_shot.seq;
    pool.latest = view;
    pool.cue = null;
    pool.anim = { shot: view.last_shot, start: performance.now() + delayMs, from: pool.match };
}

function applyMatch(view) {

    pool.match = view;
    pool.latest = view;

    pool.balls = view.balls.map(b => ({
        id: b.id, x: b.x, y: b.y, pocketed: b.pocketed, scale: 1
    }));

    const mine = view.status === "active" && view.your_turn;

    if (mine && view.ball_in_hand) {
        if (!pool.cue) {
            pool.cue = poolDefaultCueSpot(view);
            pool.mode = "place";
        }
    } else {
        pool.cue = null;
        pool.mode = "aim";
    }

    renderPoolHud();
    renderPoolOverlay();
    updatePoolControls();

    if ((view.status === "completed" || view.status === "cancelled") && !pool.resultShown) {
        showPoolResult(view);
    }
}

function poolDefaultCueSpot(view) {

    const balls = view.balls;

    for (let i = 0; i < 40; i++) {
        const x = 250 + (i % 5) * 12;
        const y = 250 + Math.ceil(i / 2) * (i % 2 ? 1 : -1) * 20;

        if (poolValidSpot(balls, x, y)) return { x, y };
    }

    return { x: 250, y: 250 };
}

function poolValidSpot(balls, x, y) {

    if (!isFinite(x) || !isFinite(y)) return false;
    if (x < POOL.R || x > POOL.W - POOL.R || y < POOL.R || y > POOL.H - POOL.R) return false;

    for (const [px, py, pr] of POOL_POCKETS) {
        if (Math.hypot(x - px, y - py) < pr + 2) return false;
    }

    return balls.every(b =>
        b.id === 0 || b.pocketed || Math.hypot(x - b.x, y - b.y) >= 2 * POOL.R + 0.5);
}


/* ------------------------------ HUD -------------------------------- */

function renderPoolConn() {

    const v = pool.match;
    const conn = poolEl("poolConn");

    conn.classList.remove("bad");

    if (pool.failures >= 2) {
        conn.textContent = "Reconnecting...";
        conn.classList.add("bad");
    } else if (v && v.status === "active" && !v.opponent_connected) {
        conn.textContent = "Opponent disconnected";
        conn.classList.add("bad");
    } else {
        conn.textContent = "Connected";
    }
}

function groupLabel(player, view) {

    if (player.group === "solids") return "Solids (1-7)";
    if (player.group === "stripes") return "Stripes (9-15)";

    return view.table_open ? "Open table" : "";
}

function renderPoolHud() {

    const v = pool.match;

    if (!v) return;

    poolEl("poolStatus").textContent = v.status_label;
    renderPoolConn();

    const wrap = poolEl("poolPlayers");
    wrap.replaceChildren();

    v.players.forEach(p => {

        const turn = v.status === "active" && v.turn === p.slot;
        const card = el("div", "pool-player" + (turn ? " turn" : ""));
        card.dataset.slot = p.slot;

        const info = el("div", "pool-player-info");
        info.append(
            el("strong", null, p.full_name + (p.slot === v.you ? " (you)" : "")),
            el("small", null, groupLabel(p, v))
        );

        // the balls this player still has to pocket
        const dots = el("div", "pool-dots");

        if (p.group) {
            const ids = p.group === "solids" ? [1, 2, 3, 4, 5, 6, 7] : [9, 10, 11, 12, 13, 14, 15];
            const alive = new Set(v.balls.filter(b => !b.pocketed).map(b => b.id));

            ids.forEach(id => {
                const dot = el("i", "pool-dot" + (alive.has(id) ? "" : " gone") + (id > 8 ? " stripe" : ""));
                dot.style.setProperty("--c", poolBallColor(id));
                dots.append(dot);
            });
        }

        info.append(dots);

        const badge = el("span", "pool-turn",
            v.status !== "active" ? "" : (turn ? (p.slot === v.you ? "Your turn" : "Their turn") : ""));

        card.append(avatarNode(p), info, badge);
        wrap.append(card);
    });

    const message = poolEl("poolMessage");
    message.textContent = v.status === "waiting"
        ? "Both players press Ready to start."
        : v.message;

    const hint = poolEl("poolHint");
    hint.textContent = poolHintText(v);
}

function poolHintText(v) {

    if (v.status !== "active") return "";

    if (!v.your_turn) return "Waiting for " + v.players.find(p => p.slot !== v.you).full_name + " to shoot.";

    if (v.ball_in_hand && pool.mode === "place") {
        return "You have the cue ball in hand. Tap the table to place it, then press Done placing.";
    }

    if (v.breaking) return "Break the rack: drag on the table to aim, set your power, then Shoot.";

    return "Drag on the table to aim. Set your power, then Shoot.";
}

function renderPoolOverlay() {

    const v = pool.match;
    const box = poolEl("poolOverlay");

    box.replaceChildren();

    if (!v) { box.classList.add("hidden"); return; }

    const me = v.players.find(p => p.slot === v.you);

    if (v.status === "waiting") {

        box.append(el("h3", null, "Waiting for players"));

        if (!me.ready) {
            box.append(el("p", null, "Press Ready when you want to begin."));
            const ready = actionButton("I'm ready", "primary", poolReady, "check");
            ready.id = "poolReadyBtn";
            box.append(ready);
        } else {
            box.append(el("p", null, "You're ready. Waiting for your opponent."));
        }

        box.classList.remove("hidden");
        return;
    }

    if (v.status === "active" && !v.opponent_connected) {

        box.append(el("h3", null, "Opponent disconnected"));

        if (v.can_claim) {
            box.append(el("p", null, "They have been away for over two minutes."));
            box.append(actionButton("Claim the win", "primary", poolClaim, "trophy"));
            box.append(actionButton("Keep waiting", "ghost", () => box.classList.add("hidden")));
        } else {
            box.append(el("p", null, "Your game is saved. If they don't return you can claim the win after two minutes."));
        }

        box.classList.remove("hidden");
        return;
    }

    box.classList.add("hidden");
}

function updatePoolControls() {

    const v = pool.match;
    const canShoot = !!v && v.status === "active" && v.your_turn && !pool.anim && !pool.sending;

    ["poolAim", "poolPower", "poolShoot", "poolAimLeft", "poolAimRight", "poolPlaceBtn"].forEach(id => {
        const node = poolEl(id);
        if (node) node.disabled = !canShoot;
    });

    const place = poolEl("poolPlaceBtn");
    place.classList.toggle("hidden", !(v && v.your_turn && v.ball_in_hand));
    place.textContent = pool.mode === "place" ? "Done placing" : "Move cue ball";

    poolEl("poolControls").classList.toggle("disabled", !canShoot);
    poolEl("poolHint").textContent = v ? poolHintText(v) : "";

    const angle = poolEl("poolAim");
    angle.value = String(Math.round(poolDegrees(pool.aim) * 10) / 10);

    poolEl("poolPower").value = String(Math.round(pool.power * 100));
    poolEl("poolPowerValue").textContent = Math.round(pool.power * 100) + "%";
}

function poolDegrees(rad) {

    let d = rad * 180 / Math.PI;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;

    return d;
}


/* ------------------------------ actions ---------------------------- */

async function poolReady() {

    try {
        const view = await api("/games/matches/" + pool.matchId + "/ready", { method: "POST" });
        applyMatch(view);
    } catch (error) {
        showToast(error.message);
        pollMatch();
    }
}

async function poolShoot() {

    const v = pool.match;

    if (!v || v.status !== "active" || !v.your_turn || pool.anim || pool.sending) return;

    const body = {
        angle: pool.aim,
        power: pool.power,
        version: (pool.latest || v).version
    };

    if (v.ball_in_hand) {
        if (!pool.cue || !poolValidSpot(pool.balls, pool.cue.x, pool.cue.y)) {
            showToast("Place the cue ball on a free spot first");
            return;
        }
        body.cue_pos = [pool.cue.x, pool.cue.y];
    }

    pool.sending = true;
    pool.strike = { start: performance.now(), ms: 150, power: pool.power };
    updatePoolControls();

    try {
        const view = await api("/games/matches/" + pool.matchId + "/shot", { method: "POST", body: body });

        startReplay(view, 150);

    } catch (error) {

        pool.strike = null;
        showToast(error.message);

        // the table changed under us: fetch the true position
        if (error.status === 409) pollMatch();
    }

    pool.sending = false;
    updatePoolControls();
}

async function poolClaim() {

    try {
        applyMatch(await api("/games/matches/" + pool.matchId + "/claim", { method: "POST" }));
    } catch (error) {
        showToast(error.message);
        pollMatch();
    }
}

function poolAskLeave() {

    const v = pool.match;
    const box = poolEl("poolConfirm");

    box.replaceChildren();

    const waiting = v && v.status === "waiting";
    const over = v && (v.status === "completed" || v.status === "cancelled");

    if (over) { closePoolView(); showScreen("games"); return; }

    box.append(
        el("h3", null, waiting ? "Leave the match?" : "Leave and forfeit?"),
        el("p", null, waiting
            ? "The match will be cancelled."
            : "Leaving ends the match and your opponent wins. To keep it going, use the back arrow instead.")
    );

    const row = el("div", "pool-two");
    row.append(
        actionButton(waiting ? "Leave" : "Forfeit", "danger", poolConfirmLeave),
        actionButton("Keep playing", "ghost", () => box.classList.add("hidden"))
    );
    box.append(row);

    box.classList.remove("hidden");
}

async function poolConfirmLeave() {

    poolEl("poolConfirm").classList.add("hidden");

    try {
        applyMatch(await api("/games/matches/" + pool.matchId + "/leave", { method: "POST" }));
    } catch (error) {
        showToast(error.message);
        pollMatch();
    }
}

// Back arrow: step out without leaving. The match keeps running.
function poolMinimize() {

    closePoolView();
    showScreen("games");
}

function closePoolView(quiet) {

    clearInterval(pool.matchTimer);
    pool.matchTimer = null;

    cancelAnimationFrame(pool.raf);
    pool.raf = 0;

    document.removeEventListener("keydown", poolKeys);

    pool.open = false;
    pool.anim = null;
    pool.confetti = null;

    const view = poolEl("poolView");
    if (view) view.classList.add("hidden");

    renderResumePill();

    if (!quiet) pollGames();
}


/* ------------------------- aiming + keyboard ----------------------- */

function poolAimInput() {

    pool.aim = Number(poolEl("poolAim").value) * Math.PI / 180;
}

function poolNudge(degrees) {

    pool.aim += degrees * Math.PI / 180;
    updatePoolControls();
}

function poolPowerInput() {

    pool.power = Math.max(0.05, Math.min(1, Number(poolEl("poolPower").value) / 100));
    poolEl("poolPowerValue").textContent = Math.round(pool.power * 100) + "%";
}

function poolTogglePlace() {

    pool.mode = pool.mode === "place" ? "aim" : "place";
    updatePoolControls();
}

function poolKeys(event) {

    if (!pool.open || event.target.matches("input[type=text], textarea")) return;

    const step = event.shiftKey ? 0.1 : (event.ctrlKey ? 2 : 0.5);

    if (event.key === "ArrowLeft") { poolNudge(-step); event.preventDefault(); }
    if (event.key === "ArrowRight") { poolNudge(step); event.preventDefault(); }

    if (event.key === "ArrowUp") {
        pool.power = Math.min(1, pool.power + 0.05); updatePoolControls(); event.preventDefault();
    }

    if (event.key === "ArrowDown") {
        pool.power = Math.max(0.05, pool.power - 0.05); updatePoolControls(); event.preventDefault();
    }

    if (event.key === " " || event.key === "Enter") {
        if (event.target.matches("button")) return;
        poolShoot();
        event.preventDefault();
    }
}

function poolPointToTable(event) {

    const rect = pool.canvas.getBoundingClientRect();

    return {
        x: (event.clientX - rect.left) / pool.scale - POOL.RAIL,
        y: (event.clientY - rect.top) / pool.scale - POOL.RAIL
    };
}

function poolPointer(event) {

    const v = pool.match;

    if (!v || v.status !== "active" || !v.your_turn || pool.anim || pool.sending) return;

    if (event.type === "pointerup" || event.type === "pointercancel") {
        pool.dragging = false;
        return;
    }

    if (event.type === "pointerdown") pool.dragging = true;
    if (!pool.dragging) return;

    const p = poolPointToTable(event);

    if (pool.mode === "place" && v.ball_in_hand) {
        pool.cue = { x: Math.max(POOL.R, Math.min(POOL.W - POOL.R, p.x)), y: Math.max(POOL.R, Math.min(POOL.H - POOL.R, p.y)) };
        return;
    }

    const cue = poolCuePosition();

    if (cue) {
        pool.aim = Math.atan2(p.y - cue.y, p.x - cue.x);
        poolEl("poolAim").value = String(Math.round(poolDegrees(pool.aim) * 10) / 10);
    }
}

function poolCuePosition() {

    const v = pool.match;

    if (v && v.ball_in_hand && pool.cue) return pool.cue;

    const cue = pool.balls.find(b => b.id === 0);

    return cue && !cue.pocketed ? cue : null;
}


/* ========================== PICTURE OF THE TABLE =================== */

function setupPoolCanvas() {

    pool.canvas = poolEl("poolCanvas");
    pool.ctx = pool.canvas.getContext ? pool.canvas.getContext("2d") : null;

    if (!pool.canvas.dataset.ready) {
        pool.canvas.dataset.ready = "1";

        ["pointerdown", "pointermove", "pointerup", "pointercancel"].forEach(type => {
            pool.canvas.addEventListener(type, poolPointer);
        });

        window.addEventListener("resize", poolResize);
        window.addEventListener("orientationchange", poolResize);
    }

    poolResize();
}

function poolResize() {

    if (!pool.canvas || !pool.open) return;

    const stage = poolEl("poolStage");
    const ratio = (POOL.W + 2 * POOL.RAIL) / (POOL.H + 2 * POOL.RAIL);

    const availW = Math.max(200, stage.clientWidth || 360);
    const top = stage.getBoundingClientRect().top || 0;
    const controls = poolEl("poolControls").offsetHeight || 150;
    const availH = Math.max(160, (window.innerHeight || 700) - top - controls - 16);

    const width = Math.min(availW, availH * ratio, 1000);

    pool.dpr = window.devicePixelRatio || 1;
    pool.scale = width / (POOL.W + 2 * POOL.RAIL);

    pool.canvas.style.width = width + "px";
    pool.canvas.style.height = (width / ratio) + "px";
    pool.canvas.width = Math.round(width * pool.dpr);
    pool.canvas.height = Math.round(width / ratio * pool.dpr);
}

// Where every ball is at time t of a recorded shot (also used by the tests)
function poolFrameAt(shot, t) {

    const frames = shot.frames;
    const pos = Math.min(Math.max(t, 0) * shot.fps, frames.length - 1);
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, frames.length - 1);
    const k = pos - i0;

    const balls = [];

    for (let b = 0; b < 16; b++) {
        const x0 = frames[i0][2 * b], y0 = frames[i0][2 * b + 1];
        const x1 = frames[i1][2 * b], y1 = frames[i1][2 * b + 1];

        balls.push(x0 < -900 ? null : { x: x0 + (x1 - x0) * k, y: y0 + (y1 - y0) * k });
    }

    const scale = new Array(16).fill(1);

    (shot.events || []).forEach(ev => {
        if (ev.type === "pocket" && t >= ev.t) {
            scale[ev.ball] = Math.max(0, 1 - (t - ev.t) / 0.18);
        }
    });

    return { balls, scale };
}

function poolStepAnimation(now) {

    const a = pool.anim;

    if (!a) return;

    const t = (now - a.start) / 1000;

    if (t < 0) return;                       // the cue is still striking

    const frame = poolFrameAt(a.shot, t);

    pool.balls = frame.balls.map((p, id) => ({
        id: id,
        x: p ? p.x : -999,
        y: p ? p.y : -999,
        pocketed: !p || frame.scale[id] <= 0,
        scale: frame.scale[id]
    }));

    if (t >= a.shot.seconds + 0.45) {
        pool.anim = null;
        pool.strike = null;
        applyMatch(pool.latest);
        updatePoolControls();
    }
}

function poolLoop(now) {

    if (!pool.open) return;

    pool.raf = requestAnimationFrame(poolLoop);

    poolStepAnimation(now);
    drawPool(now);
}

function poolRoundRect(ctx, x, y, w, h, r) {

    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

function drawPoolTable(ctx) {

    const TW = POOL.W + 2 * POOL.RAIL, TH = POOL.H + 2 * POOL.RAIL, RL = POOL.RAIL;

    // wooden frame
    const wood = ctx.createLinearGradient(0, 0, 0, TH);
    wood.addColorStop(0, "#7a4b2a");
    wood.addColorStop(0.5, "#5b3a22");
    wood.addColorStop(1, "#46291a");
    ctx.fillStyle = wood;
    poolRoundRect(ctx, 0, 0, TW, TH, 26);
    ctx.fill();

    // cushions and felt
    ctx.fillStyle = "#0a4f31";
    poolRoundRect(ctx, RL - 16, RL - 16, POOL.W + 32, POOL.H + 32, 12);
    ctx.fill();

    const felt = ctx.createRadialGradient(TW / 2, TH / 2, 60, TW / 2, TH / 2, TW * 0.6);
    felt.addColorStop(0, "#1b8a56");
    felt.addColorStop(1, "#0d6040");
    ctx.fillStyle = felt;
    ctx.fillRect(RL, RL, POOL.W, POOL.H);

    // markings
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(RL + POOL.W * 0.25, RL);
    ctx.lineTo(RL + POOL.W * 0.25, RL + POOL.H);
    ctx.stroke();

    ctx.fillStyle = "rgba(255,255,255,0.25)";
    ctx.beginPath(); ctx.arc(RL + POOL.W * 0.75, RL + POOL.H / 2, 3, 0, 7); ctx.fill();

    // rail diamonds
    ctx.fillStyle = "#e8d3a2";
    for (let i = 1; i < 8; i++) {
        if (i === 4) continue;
        const x = RL + POOL.W * i / 8;
        ctx.beginPath(); ctx.arc(x, RL / 2 - 4, 3.2, 0, 7); ctx.fill();
        ctx.beginPath(); ctx.arc(x, TH - RL / 2 + 4, 3.2, 0, 7); ctx.fill();
    }
    for (let j = 1; j < 4; j++) {
        const y = RL + POOL.H * j / 4;
        ctx.beginPath(); ctx.arc(RL / 2 - 4, y, 3.2, 0, 7); ctx.fill();
        ctx.beginPath(); ctx.arc(TW - RL / 2 + 4, y, 3.2, 0, 7); ctx.fill();
    }

    // pockets
    POOL_POCKETS.forEach(([px, py, pr], i) => {
        const cx = RL + px + (px === 0 ? -6 : px === POOL.W ? 6 : 0);
        const cy = RL + py + (py === 0 ? -6 : py === POOL.H ? 6 : 0);
        const g = ctx.createRadialGradient(cx, cy, 2, cx, cy, pr);
        g.addColorStop(0, "#000");
        g.addColorStop(1, "#141414");
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(cx, cy, pr * (i < 4 ? 0.95 : 0.9), 0, 7); ctx.fill();
    });
}

function drawPoolBall(ctx, id, x, y, scale, alpha) {

    const r = POOL.R * scale;

    if (r <= 0.3) return;

    ctx.save();
    ctx.globalAlpha = alpha === undefined ? 1 : alpha;
    ctx.translate(x, y);

    // shadow
    ctx.fillStyle = "rgba(0,0,0,0.28)";
    ctx.beginPath(); ctx.ellipse(2.5, 3.5, r, r * 0.92, 0, 0, 7); ctx.fill();

    ctx.beginPath(); ctx.arc(0, 0, r, 0, 7); ctx.clip();

    if (id === 0) {
        ctx.fillStyle = "#f6f4ec";
        ctx.fillRect(-r, -r, 2 * r, 2 * r);
    } else if (id > 8) {
        ctx.fillStyle = "#f6f4ec";
        ctx.fillRect(-r, -r, 2 * r, 2 * r);
        ctx.fillStyle = poolBallColor(id);
        ctx.fillRect(-r, -r * 0.55, 2 * r, r * 1.1);
    } else {
        ctx.fillStyle = poolBallColor(id);
        ctx.fillRect(-r, -r, 2 * r, 2 * r);
    }

    if (id !== 0) {
        ctx.fillStyle = "#fff";
        ctx.beginPath(); ctx.arc(0, 0, r * 0.46, 0, 7); ctx.fill();
        ctx.fillStyle = "#111";
        ctx.font = "bold " + (r * 0.62) + "px Arial, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(id), 0, r * 0.04);
    }

    const shine = ctx.createRadialGradient(-r * 0.35, -r * 0.4, 1, -r * 0.1, -r * 0.1, r * 1.1);
    shine.addColorStop(0, "rgba(255,255,255,0.65)");
    shine.addColorStop(0.35, "rgba(255,255,255,0.08)");
    shine.addColorStop(1, "rgba(0,0,0,0.28)");
    ctx.fillStyle = shine;
    ctx.fillRect(-r, -r, 2 * r, 2 * r);

    ctx.restore();
}

// Where the cue ball would first touch something (a guide only; the server decides the shot)
function poolPredict(cx, cy, angle, balls) {

    const dx = Math.cos(angle), dy = Math.sin(angle);
    const d = 2 * POOL.R;
    let best = { t: Infinity, ball: null };

    balls.forEach(b => {
        if (b.id === 0 || b.pocketed) return;

        const fx = cx - b.x, fy = cy - b.y;
        const bq = fx * dx + fy * dy;
        const disc = bq * bq - (fx * fx + fy * fy - d * d);

        if (disc < 0) return;

        const t = -bq - Math.sqrt(disc);

        if (t > 0 && t < best.t) best = { t: t, ball: b };
    });

    const rails = [];
    if (dx > 0) rails.push((POOL.W - POOL.R - cx) / dx);
    if (dx < 0) rails.push((POOL.R - cx) / dx);
    if (dy > 0) rails.push((POOL.H - POOL.R - cy) / dy);
    if (dy < 0) rails.push((POOL.R - cy) / dy);

    const tr = Math.min(...rails.filter(t => t > 0));

    if (tr < best.t) best = { t: tr, ball: null };

    return { x: cx + dx * best.t, y: cy + dy * best.t, ball: best.ball };
}

function drawPoolCue(ctx, cue, now) {

    const guide = poolPredict(cue.x, cue.y, pool.aim, pool.balls);

    // aiming line and where the cue ball lands
    ctx.save();
    ctx.setLineDash([8, 7]);
    ctx.strokeStyle = "rgba(255,255,255,0.75)";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(cue.x, cue.y); ctx.lineTo(guide.x, guide.y); ctx.stroke();
    ctx.setLineDash([]);

    ctx.strokeStyle = "rgba(255,255,255,0.8)";
    ctx.beginPath(); ctx.arc(guide.x, guide.y, POOL.R, 0, 7); ctx.stroke();

    if (guide.ball) {
        const ax = guide.ball.x - guide.x, ay = guide.ball.y - guide.y;
        const len = Math.hypot(ax, ay) || 1;
        ctx.strokeStyle = "rgba(255,230,120,0.9)";
        ctx.beginPath();
        ctx.moveTo(guide.ball.x, guide.ball.y);
        ctx.lineTo(guide.ball.x + ax / len * 60, guide.ball.y + ay / len * 60);
        ctx.stroke();
    }
    ctx.restore();

    // the cue stick, pulled back by the power (and thrust forward when you shoot)
    let pull = 14 + pool.power * 90;

    if (pool.strike && now) {
        const k = Math.min(1, (now - pool.strike.start) / pool.strike.ms);
        pull = pull * (1 - k);
    }

    ctx.save();
    ctx.translate(cue.x, cue.y);
    ctx.rotate(pool.aim);

    const start = -(POOL.R + 4 + pull);
    const grad = ctx.createLinearGradient(start - 420, 0, start, 0);
    grad.addColorStop(0, "#2b1a10");
    grad.addColorStop(0.15, "#8a5a33");
    grad.addColorStop(1, "#e8d3a2");

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(start, -2.2);
    ctx.lineTo(start - 420, -5.5);
    ctx.lineTo(start - 420, 5.5);
    ctx.lineTo(start, 2.2);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = "#6fb7d6";
    ctx.fillRect(start - 5, -2.2, 5, 4.4);
    ctx.restore();
}

function drawPool(now) {

    const ctx = pool.ctx;

    if (!ctx || !pool.canvas) return;

    const s = pool.scale * pool.dpr;

    ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.clearRect(0, 0, pool.canvas.width / s, pool.canvas.height / s);

    drawPoolTable(ctx);

    ctx.save();
    ctx.translate(POOL.RAIL, POOL.RAIL);

    const v = pool.match;
    const placing = v && v.status === "active" && v.your_turn && v.ball_in_hand && pool.cue && !pool.anim;

    pool.balls.forEach(b => {
        if (b.pocketed && b.scale >= 1) return;
        if (b.id === 0 && placing) return;
        if (b.x < -900) return;

        drawPoolBall(ctx, b.id, b.x, b.y, b.scale === undefined ? 1 : b.scale);
    });

    const myTurn = v && v.status === "active" && v.your_turn && !pool.anim;

    if (myTurn) {
        if (placing) {
            const ok = poolValidSpot(pool.balls, pool.cue.x, pool.cue.y);
            drawPoolBall(ctx, 0, pool.cue.x, pool.cue.y, 1, ok ? 1 : 0.55);

            ctx.strokeStyle = ok ? "rgba(255,255,255,0.9)" : "#ff5a5a";
            ctx.lineWidth = 2;
            ctx.setLineDash([5, 4]);
            ctx.beginPath(); ctx.arc(pool.cue.x, pool.cue.y, POOL.R + 5, 0, 7); ctx.stroke();
            ctx.setLineDash([]);
        }

        if (pool.mode === "aim" || pool.strike) {
            const cue = poolCuePosition();
            if (cue) drawPoolCue(ctx, cue, now);
        }
    } else if (pool.strike && pool.anim) {
        const cue = pool.balls.find(b => b.id === 0);
        if (cue && now < pool.anim.start) drawPoolCue(ctx, cue, now);
    }

    ctx.restore();
}


/* ============================ RESULT SCREEN ======================= */

function showPoolResult(view) {

    pool.resultShown = true;

    renderPoolResult();

    if (view.result && view.result.you_won) startPoolConfetti();
}

function renderPoolResult() {

    const v = pool.match;
    const box = poolEl("poolResult");

    if (!v || !v.result || !pool.resultShown) return;

    const r = v.result;
    const me = v.players.find(p => p.slot === v.you);
    const them = v.players.find(p => p.slot !== v.you);

    const outcome = r.winner_slot ? (r.you_won ? "win" : "loss") : "ended";

    box.className = "pool-result " + outcome;
    box.replaceChildren();

    const card = el("div", "pool-result-card");

    const icon = el("div", "pool-result-icon");
    icon.append(poolIcon(outcome === "win" ? "trophy" : "flag", 34));

    const title = el("h2", "pool-result-title",
        outcome === "win" ? "YOU WIN!" : outcome === "loss" ? "YOU LOST" : "MATCH ENDED");

    const faces = el("div", "pool-faces");
    const mine = avatarNode(me, "large");
    const theirs = avatarNode(them, "large");

    if (outcome === "win") mine.classList.add("winner");
    if (outcome === "loss") theirs.classList.add("winner");

    const vs = el("span", "pool-vs", "vs");
    faces.append(mine, vs, theirs);

    const names = el("div", "pool-names");
    names.append(el("strong", null, me.full_name), el("strong", null, them.full_name));

    const reason = el("p", "pool-reason", r.reason || "");

    const winnerLine = r.winner_slot
        ? "Winner: " + v.players.find(p => p.slot === r.winner_slot).full_name
        : "No winner";

    const stats = el("div", "pool-stats-table");
    [["", me.full_name.split(" ")[0], them.full_name.split(" ")[0]],
     ["Shots", r.stats[me.slot].shots, r.stats[them.slot].shots],
     ["Balls pocketed", r.stats[me.slot].pocketed, r.stats[them.slot].pocketed],
     ["Fouls", r.stats[me.slot].fouls, r.stats[them.slot].fouls]].forEach((row, i) => {
        const line = el("div", "pool-stat-row" + (i === 0 ? " head" : ""));
        row.forEach(cell => line.append(el("span", null, String(cell))));
        stats.append(line);
    });

    const meta = el("p", "pool-meta", winnerLine + "  \u00b7  Match time " + poolClock(r.duration_seconds) +
        "  \u00b7  " + (v.demo ? "Free match" : "Stake match"));

    const buttons = el("div", "pool-two");

    const incomingRematch = pool.incoming.find(c => c.rematch && c.user.username === them.username);

    let label = "Play Again";
    if (pool.rematchPending) label = "Waiting for " + them.full_name.split(" ")[0] + "...";
    if (incomingRematch) label = "Accept rematch";

    const again = actionButton(label, "primary", poolPlayAgain, null, pool.rematchPending && !incomingRematch);
    const back = actionButton("Return to Games", "ghost", () => { closePoolView(); showScreen("games"); });
    buttons.append(again, back);

    card.append(icon, title, faces, names, reason, meta, stats, buttons);
    box.append(card);

    if (outcome === "win") box.append(el("canvas", "pool-confetti"));
}

async function poolPlayAgain() {

    if (pool.rematchPending) return;

    try {
        const result = await api("/games/matches/" + pool.matchId + "/rematch", { method: "POST" });

        if (result.match_id) {              // they had already asked: it starts now
            openPoolMatch(result.match_id);
            return;
        }

        pool.rematchPending = true;
        pool.waiting = {
            id: result.id,
            name: pool.match.players.find(p => p.slot !== pool.match.you).full_name,
            rematch: true
        };

        renderPoolResult();

    } catch (error) {
        showToast(error.message);
    }
}

function startPoolConfetti() {

    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const canvas = poolEl("poolResult").querySelector(".pool-confetti");

    if (reduce || !canvas || !canvas.getContext) return;

    const ctx = canvas.getContext("2d");

    if (!ctx) return;

    canvas.width = canvas.clientWidth || 360;
    canvas.height = canvas.clientHeight || 600;

    const colors = ["#f4c20d", "#1565c0", "#d32f2f", "#2e7d32", "#ef6c00", "#6a1b9a", "#ffffff"];
    const bits = [];

    for (let i = 0; i < 120; i++) {
        bits.push({
            x: canvas.width / 2, y: canvas.height * 0.3,
            vx: (Math.random() - 0.5) * 9, vy: -Math.random() * 9 - 3,
            size: 4 + Math.random() * 5, spin: Math.random() * 6,
            color: colors[i % colors.length]
        });
    }

    const born = performance.now();
    pool.confetti = born;

    function frame(now) {
        if (pool.confetti !== born || !pool.open) return;

        const age = (now - born) / 1000;
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        bits.forEach(b => {
            b.vy += 0.22;
            b.x += b.vx;
            b.y += b.vy;
            b.spin += 0.2;

            ctx.globalAlpha = Math.max(0, 1 - age / 3.8);
            ctx.fillStyle = b.color;
            ctx.save();
            ctx.translate(b.x, b.y);
            ctx.rotate(b.spin);
            ctx.fillRect(-b.size / 2, -b.size / 4, b.size, b.size / 2);
            ctx.restore();
        });

        if (age < 3.8) requestAnimationFrame(frame);
        else ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    requestAnimationFrame(frame);
}
