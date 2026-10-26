/* Vynqo World Chat: floating community panel (bottom-left launcher).
   Completely separate from private Direct Messages. Loaded after messages.js so it can reuse api().

   Rules this file follows:
   - The panel NEVER opens by itself. Only the launcher (or the panel's own minimize button) toggles it.
   - Message polling runs only while the panel is open and the tab is visible. While it is closed, one
     tiny request every 20 s asks only for the unread-reply count (that is what the launcher badge shows).
   - The badge counts ONLY direct replies to the current user's own messages, as decided by the server.
   - Every timer and listener is created once; responses that arrive after a logout/login are dropped. */
(() => {
  "use strict";

  const POLL_OPEN_MS = 3500;        // message poll while the panel is open
  const POLL_MAX_MS = 15000;        // back-off ceiling after failures
  const BADGE_POLL_MS = 20000;      // unread-reply count poll while the panel is closed
  const READ_DEBOUNCE_MS = 600;     // batch "I saw these replies" calls
  const PAGE_LIMIT = 100;           // must match the server's maximum page for after_id polls
  const MAX_DOM_MESSAGES = 300;     // keep the list light during very long sessions
  const MAX_TRAY_ROUNDS = 3;        // extra unread-reply fetches per opening, if more than one page exists

  const ICONS = {
    reply: '<polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>',
    game: '<line x1="6" x2="10" y1="11" y2="11"/><line x1="8" x2="8" y1="9" y2="13"/><line x1="15" x2="15.01" y1="12" y2="12"/><line x1="18" x2="18.01" y1="10" y2="10"/><path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z"/>'
  };

  const state = {
    ready: false,            // static listeners attached
    authed: false,
    open: false,
    session: 0,              // bumped on login and logout; late responses from an older session are ignored
    loadedOnce: false,
    loading: false,
    lastId: 0,
    knownIds: new Set(),
    cards: new Map(),        // invitation id -> rendered card element
    reqCards: new Map(),     // join-request id -> rendered card element
    openedMatches: new Set(),// matches we already jumped into (never open one twice)
    invSince: null,          // server_time of the last response, used to fetch invitation changes
    pollTimer: null,
    pollBusy: false,
    pollFailures: 0,
    badgeTimer: null,
    badgeBusy: false,
    unread: 0,
    replyTo: null,           // { id, name, body }
    sending: false,
    observer: null,
    pendingRead: new Set(),
    readTimer: null,
    readBusy: false,
    trayRounds: 0,
    noticeTimer: null
  };

  const $ = (id) => document.getElementById(id);

  /* ---------------------------------------------------------------- helpers */

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function icon(name, size) {
    const t = document.createElement("template");
    t.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size +
      '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' + ICONS[name] + "</svg>";
    return t.content.firstChild;
  }

  function senderName(user, mine) {
    if (mine) return "You";
    if (!user) return "Vynqo member";
    return user.full_name || (user.username ? "@" + user.username : "Vynqo member");
  }

  function timeLabel(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (d.toDateString() === new Date().toDateString()) return time;
    return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " · " + time;
  }

  function snippet(text, max) {
    const t = String(text || "").replace(/\s+/g, " ").trim();
    return t.length > max ? t.slice(0, max).trimEnd() + "…" : t;
  }

  function notice(message, kind) {
    const node = $("worldChatNotice");
    if (!node) return;
    clearTimeout(state.noticeTimer);
    node.textContent = message || "";
    if (message && kind) node.dataset.kind = kind; else delete node.dataset.kind;
    if (message && kind === "ok") {
      const session = state.session;
      state.noticeTimer = setTimeout(() => { if (session === state.session) notice(""); }, 4000);
    }
  }

  // The full-screen private chat and the pool game sit above the panel; nothing underneath counts as "seen".
  function covered() {
    return ["chatView", "poolView"].some((id) => {
      const node = $(id);
      return node && !node.classList.contains("hidden");
    });
  }

  function canSee() { return state.open && !document.hidden && !covered(); }

  /* ------------------------------------------------------------------ badge */

  function setBadge(count) {
    const n = Math.max(0, Number(count) || 0);
    const badge = $("worldChatBadge");
    const launcher = $("worldChatLauncher");
    const grew = n > state.unread;
    state.unread = n;
    if (badge) {
      badge.textContent = n > 9 ? "9+" : String(n);
      badge.classList.toggle("hidden", n === 0);
      if (grew) { badge.classList.remove("pop"); void badge.offsetWidth; badge.classList.add("pop"); }
    }
    if (launcher) {
      const base = state.open ? "Minimize World Chat" : "Open World Chat";
      launcher.setAttribute("aria-label", n ? base + ", " + n + (n === 1 ? " new reply to you" : " new replies to you") : base);
    }
  }

  /* ---- closed-state badge polling: one timer, only the cheap count endpoint ---- */

  function stopBadgePolling() { clearTimeout(state.badgeTimer); state.badgeTimer = null; }

  function startBadgePolling() {
    if (state.badgeTimer || !state.authed || state.open || document.hidden) return;
    state.badgeTimer = setTimeout(async () => {
      state.badgeTimer = null;
      if (!state.authed || state.open || document.hidden) return;
      await refreshBadge();
      startBadgePolling();
    }, BADGE_POLL_MS);
  }

  async function refreshBadge() {
    if (state.badgeBusy || !state.authed) return;
    state.badgeBusy = true;
    const session = state.session;
    try {
      const data = await api("/world-chat/unread-count");
      if (session === state.session && !state.open) setBadge(data.count);
    } catch (_) { /* background check: stay quiet */ }
    finally { if (session === state.session) state.badgeBusy = false; }
  }

  /* The launcher lives on the Messages tab only; leaving that tab minimizes the panel. */
  function onMessagesTab() {
    const screen = $("messagesScreen");
    return !!screen && screen.classList.contains("active");
  }

  function syncLauncherVisibility() {
    if (!state.ready) return;
    const show = state.authed && onMessagesTab();
    $("worldChatRoot").classList.toggle("wc-off", !show);
    if (!show && state.open) closePanel(true);
  }

  /* ------------------------------------------------------------ open / close */

  function openPanel() {
    if (!state.authed || state.open) return;
    state.open = true;
    $("worldChatPanel").classList.remove("hidden");
    $("worldChatRoot").classList.add("is-open");
    $("worldChatLauncher").setAttribute("aria-expanded", "true");
    stopBadgePolling();
    setBadge(state.unread);

    state.trayRounds = 0;
    if (state.loadedOnce) pollNow(); else loadInitial();
    loadUnreadReplies();
    startPolling();
    rescanUnread();

    if (window.matchMedia && window.matchMedia("(pointer: fine)").matches) $("worldChatInput").focus();
  }

  function closePanel(silent) {
    if (!state.open) return;
    state.open = false;
    $("worldChatPanel").classList.add("hidden");
    $("worldChatRoot").classList.remove("is-open");
    $("worldChatLauncher").setAttribute("aria-expanded", "false");
    stopPolling();
    flushRead();                       // register anything the user already saw
    clearTray();                       // it is rebuilt from the server next time
    toggleInviteForm(false);
    setBadge(state.unread);
    startBadgePolling();
    if (!silent) $("worldChatLauncher").focus();
  }

  function togglePanel() { if (state.open) closePanel(); else openPanel(); }

  /* ------------------------------------------------------ message list state */

  function messagesBox() { return $("worldChatMessages"); }

  function clearStatus() { messagesBox().querySelectorAll(".wc-status").forEach((n) => n.remove()); }

  function showStatus(kind, detail) {
    const box = messagesBox();
    box.replaceChildren();
    const wrap = el("div", "wc-status");
    if (kind === "loading") {
      wrap.append(el("div", "wc-spinner"), document.createTextNode("Loading World Chat…"));
    } else if (kind === "empty") {
      wrap.append(el("strong", "", "No messages yet"),
        document.createTextNode("Be the first to say hello, or tap Find players to start a game."));
    } else {
      wrap.append(el("strong", "", "Couldn't load World Chat"), document.createTextNode(detail || "Check your connection and try again."));
      const retry = el("button", "wc-primary-btn", "Try again");
      retry.type = "button";
      retry.addEventListener("click", () => { showStatus("loading"); loadInitial(); });
      wrap.append(document.createElement("br"), retry);
    }
    box.append(wrap);
  }

  function resetMessages() {
    const box = messagesBox();
    // Stop watching only the nodes being removed; the replies tray has its own observed rows.
    if (state.observer) box.querySelectorAll("[data-unread-reply]").forEach((n) => state.observer.unobserve(n));
    box.replaceChildren();
    state.knownIds = new Set();
    state.cards = new Map();
    state.reqCards = new Map();
    state.lastId = 0;
    hideNewPill();
  }

  function nearBottom() {
    const box = messagesBox();
    return box.scrollHeight - box.scrollTop - box.clientHeight < 90;
  }
  function scrollToBottom() { const box = messagesBox(); box.scrollTop = box.scrollHeight; hideNewPill(); }
  function showNewPill() { $("worldChatNewPill").classList.remove("hidden"); }
  function hideNewPill() { const pill = $("worldChatNewPill"); if (pill) pill.classList.add("hidden"); }

  /* ----------------------------------------------------------- rendering */

  function buildQuote(reply) {
    const quote = el("button", "wc-quote");
    quote.type = "button";
    quote.title = "Show the original message";
    quote.append(el("strong", "", senderName(reply.sender, reply.mine)), el("span", "", reply.body || ""));
    quote.addEventListener("click", () => jumpTo(reply.id));
    return quote;
  }

  function buildMessage(m) {
    const mine = !!m.mine;
    const article = el("article", "wc-msg" + (mine ? " mine" : ""));
    article.dataset.messageId = String(m.id);

    const head = el("div", "wc-msg-head");
    head.append(el("strong", "", senderName(m.sender, mine)));
    if (m.unread_reply) head.append(el("span", "wc-msg-tag", "Replied to you"));
    const time = el("time", "", timeLabel(m.created_at));
    time.dateTime = m.created_at || "";
    time.title = m.created_at ? new Date(m.created_at).toLocaleString() : "";
    head.append(time);
    article.append(head);

    if (m.reply_to) article.append(buildQuote(m.reply_to));
    article.append(el("div", "wc-msg-body", m.body || ""));

    if (m.message_type === "GAME_INVITATION" && m.invitation) {
      const card = buildInvitationCard(m.invitation);
      state.cards.set(m.invitation.id, card);
      article.append(card);
    }

    if (m.message_type === "JOIN_REQUEST" && m.request) {
      const card = buildRequestCard(m.request);
      state.reqCards.set(m.request.id, card);
      article.append(card);
    }

    if (!mine) {
      const actions = el("div", "wc-msg-actions");
      const replyBtn = el("button", "wc-reply-btn");
      replyBtn.type = "button";
      replyBtn.setAttribute("aria-label", "Reply to " + senderName(m.sender, false));
      replyBtn.append(icon("reply", 13), document.createTextNode("Reply"));
      replyBtn.addEventListener("click", () => startReply(m));
      actions.append(replyBtn);
      article.append(actions);
    }

    if (m.unread_reply) {
      article.classList.add("is-unread-reply");
      article.dataset.unreadReply = String(m.id);
    }
    return article;
  }

  // Messages normally arrive in order; if a send response and a poll cross, slot it in by id.
  function insertSorted(box, node, id) {
    let ref = box.lastElementChild;
    while (ref && Number(ref.dataset.messageId) > id) ref = ref.previousElementSibling;
    if (ref) ref.after(node); else box.prepend(node);
  }

  function addMessage(m) {
    if (!m || !m.id || state.knownIds.has(m.id)) return false;
    clearStatus();
    const box = messagesBox();
    const node = buildMessage(m);
    insertSorted(box, node, Number(m.id));
    state.knownIds.add(m.id);
    state.lastId = Math.max(state.lastId, Number(m.id) || 0);
    if (node.dataset.unreadReply) observeUnread(node);
    return true;
  }

  function trimOldMessages() {
    const box = messagesBox();
    while (box.children.length > MAX_DOM_MESSAGES) {
      const first = box.firstElementChild;
      state.knownIds.delete(Number(first.dataset.messageId));
      if (first.dataset.unreadReply && state.observer) state.observer.unobserve(first);
      const card = first.querySelector(".wc-game");
      if (card) state.cards.delete(Number(card.dataset.invitationId));
      first.remove();
    }
  }

  function jumpTo(id) {
    const target = messagesBox().querySelector('[data-message-id="' + Number(id) + '"]');
    if (!target) { notice("That message is further back than the recent history.", ""); return; }
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    target.classList.remove("flash");
    void target.offsetWidth;
    target.classList.add("flash");
  }

  /* --------------------------------------------------- game invitation card */

  function stateLabel(value) {
    return { OPEN: "Open", STARTED: "Started", CLOSED: "Closed", CANCELLED: "Cancelled" }[value] || value || "Open";
  }

  function buildInvitationCard(inv) {
    const card = el("div", "wc-game");
    card.dataset.invitationId = String(inv.id);
    card.dataset.updatedAt = String(Date.parse(inv.updated_at) || 0);   // lets us ignore stale payloads

    const head = el("div", "wc-game-head");
    head.append(icon("game", 18), el("strong", "", inv.game_type || "Game"));
    head.append(el("span", "wc-state " + String(inv.state || "OPEN").toLowerCase(), stateLabel(inv.state)));
    card.append(head);

    const count = Number(inv.participant_count ?? (Array.isArray(inv.participants) ? inv.participants.length : 0));
    const max = Number(inv.max_participants || 4);
    const host = inv.hosted_by_me ? "you" : (inv.host && inv.host.username ? "@" + inv.host.username : "a community member");
    card.append(el("div", "wc-game-meta", count + "/" + max + " players · hosted by " + host));

    const names = (Array.isArray(inv.participants) ? inv.participants : [])
      .map((p) => p.user && (p.user.full_name || p.user.username)).filter(Boolean);
    if (names.length) {
      const shown = names.slice(0, 4).join(", ") + (names.length > 4 ? " +" + (names.length - 4) : "");
      card.append(el("div", "wc-game-meta", "Joined: " + shown));
    }
    if (inv.details) card.append(el("div", "wc-game-meta", inv.details));

    if (inv.state === "OPEN") {
      const actions = el("div", "wc-game-actions");
      const joined = !!inv.joined_by_me;
      const full = count >= max;

      if (!inv.hosted_by_me) {
        const asked = !joined && !!inv.requested_by_me;
        const label = joined ? "Leave game" : asked ? "Request sent" : full ? "Full" : "Request to join";
        const toggle = el("button", joined || asked ? "" : "primary", label);
        toggle.type = "button";
        toggle.disabled = asked || (!joined && full);
        toggle.addEventListener("click", () => inviteAction(toggle, inv.id, joined ? "leave" : "join"));
        actions.append(toggle);
      }
      if (inv.hosted_by_me) {
        [["STARTED", "Mark started", "primary"], ["CLOSED", "Close", ""], ["CANCELLED", "Cancel game", "subtle"]].forEach(([value, label, cls]) => {
          const b = el("button", cls, label);
          b.type = "button";
          b.addEventListener("click", () => inviteAction(b, inv.id, "state", value));
          actions.append(b);
        });
      }
      card.append(actions);
    }
    return card;
  }

  function updateInvitation(inv) {
    const old = state.cards.get(inv.id);
    if (!old || !old.isConnected) return;
    // A poll that was answered before a join/leave but delivered after it must not undo it.
    if ((Date.parse(inv.updated_at) || 0) < Number(old.dataset.updatedAt || 0)) return;
    const fresh = buildInvitationCard(inv);
    old.replaceWith(fresh);
    state.cards.set(inv.id, fresh);
  }

  /* ------------------------------------------------ join request card */

  function buildRequestCard(req) {
    const card = el("div", "wc-req");
    card.dataset.requestId = String(req.id);
    card.dataset.status = req.status;
    card.dataset.updatedAt = String(Date.parse(req.updated_at) || 0);
    const who = req.mine ? "You" : senderName(req.requester, false);
    const actions = el("div", "wc-game-actions");

    if (req.status === "PENDING") {
      if (req.can_respond) {
        card.append(el("div", "wc-game-meta", "Accept to " + (req.is_pool ? "start a pool match with " : "let ") + who + (req.is_pool ? "." : " join.")));
        const accept = el("button", "primary", req.is_pool ? "Accept & play" : "Accept");
        accept.type = "button";
        accept.addEventListener("click", () => requestAction(actions, req.id, "accept"));
        const decline = el("button", "", "Decline");
        decline.type = "button";
        decline.addEventListener("click", () => requestAction(actions, req.id, "decline"));
        actions.append(accept, decline);
      } else if (req.mine) {
        card.append(el("div", "wc-game-meta", "Waiting for the host to accept…"));
        const cancel = el("button", "subtle", "Cancel request");
        cancel.type = "button";
        cancel.addEventListener("click", () => requestAction(actions, req.id, "cancel"));
        actions.append(cancel);
      } else {
        card.append(el("div", "wc-game-meta", "Waiting for the host to accept…"));
      }
    } else if (req.status === "ACCEPTED") {
      card.append(el("div", "wc-game-meta", "Accepted" + (req.match_id ? ". The match is ready." : ". You're in.")));
      if (req.match_id && req.involved && typeof openPoolMatch === "function") {
        const play = el("button", "primary", "Play now");
        play.type = "button";
        play.addEventListener("click", () => enterMatch(req.match_id));
        actions.append(play);
      }
    } else {
      card.append(el("div", "wc-game-meta", req.status === "DECLINED" ? "Request declined." : "Request cancelled."));
    }
    if (actions.children.length) card.append(actions);
    return card;
  }

  function enterMatch(matchId) {
    if (!matchId || typeof openPoolMatch !== "function") return;
    if (state.open) closePanel(true);
    openPoolMatch(matchId);
  }

  function updateRequest(req) {
    const old = state.reqCards.get(req.id);
    if (!old || !old.isConnected) return;
    if ((Date.parse(req.updated_at) || 0) < Number(old.dataset.updatedAt || 0)) return;
    const wasPending = old.dataset.status === "PENDING";
    const fresh = buildRequestCard(req);
    old.replaceWith(fresh);
    state.reqCards.set(req.id, fresh);
    // The player who asked is taken into the game as soon as the host accepts (once).
    if (wasPending && req.status === "ACCEPTED" && req.mine && req.match_id && !state.openedMatches.has(req.match_id)) {
      state.openedMatches.add(req.match_id);
      showToastSafe("Your game request was accepted. Starting the match…");
      enterMatch(req.match_id);
    }
  }

  function showToastSafe(text) { if (typeof showToast === "function") showToast(text); }

  async function requestAction(box, id, action) {
    const session = state.session;
    box.querySelectorAll("button").forEach((b) => { b.disabled = true; });
    try {
      const data = await api("/world-chat/requests/" + id + "/" + action, { method: "POST", body: {} });
      if (session !== state.session) return;
      if (data.request) updateRequest(data.request);
      if (data.invitation) updateInvitation(data.invitation);
      if (action === "accept" && data.match_id && !state.openedMatches.has(data.match_id)) {
        state.openedMatches.add(data.match_id);
        enterMatch(data.match_id);
      }
      notice("");
    } catch (error) {
      if (session !== state.session) return;
      notice(error.message || "Could not answer the request.", "error");
      box.querySelectorAll("button").forEach((b) => { b.disabled = false; });
    }
  }

  async function inviteAction(button, id, action, value) {
    const session = state.session;
    const buttons = button.parentElement ? button.parentElement.querySelectorAll("button") : [button];
    buttons.forEach((b) => { b.disabled = true; });
    try {
      const data = await api("/world-chat/invitations/" + id + "/" + action,
        { method: "POST", body: action === "state" ? { state: value } : {} });
      if (session !== state.session) return;
      if (data.message && data.message.id) addMessage(data.message);
      if (data.invitation) updateInvitation(data.invitation);
      if (action === "join" && data.request) { notice("Request sent. The host will see it in World Chat.", "ok"); scrollToBottom(); }
      else notice("");
    } catch (error) {
      if (session !== state.session) return;
      notice(error.message || "Could not update the game.", "error");
      buttons.forEach((b) => { b.disabled = false; });
    }
  }

  /* ------------------------------------------------------------- loading */

  async function loadInitial() {
    if (state.loading || !state.authed) return;
    const session = state.session;
    state.loading = true;
    if (!state.loadedOnce && !messagesBox().querySelector(".wc-status")) showStatus("loading");
    try {
      const data = await api("/world-chat/messages?limit=50");
      if (session !== state.session) return;
      resetMessages();
      const list = Array.isArray(data.messages) ? data.messages : [];
      list.forEach(addMessage);
      if (!list.length) showStatus("empty");
      state.loadedOnce = true;
      state.pollFailures = 0;
      state.invSince = data.server_time || null;
      setBadge(data.unread_reply_count);
      notice("");
      scrollToBottom();
    } catch (error) {
      if (session !== state.session) return;
      state.pollFailures += 1;            // automatic retries back off instead of hammering the server
      if (!state.loadedOnce) showStatus("error", error && error.message && error.message !== "Something went wrong" ? error.message : "");
      else notice("Couldn't refresh World Chat. Retrying…", "error");
    } finally {
      if (session === state.session) state.loading = false;
    }
  }

  async function pollOnce() {
    if (state.pollBusy || state.loading || !state.authed) return;
    if (!state.loadedOnce) { await loadInitial(); return; }
    const session = state.session;
    state.pollBusy = true;
    try {
      let path = "/world-chat/messages?after_id=" + state.lastId + "&limit=" + PAGE_LIMIT;
      if (state.invSince) path += "&inv_since=" + encodeURIComponent(state.invSince);
      const data = await api(path);
      if (session !== state.session) return;
      state.pollFailures = 0;
      notice("");
      const list = Array.isArray(data.messages) ? data.messages : [];

      // A full page means there may be a gap between what we have and what came back: start clean.
      if (list.length >= PAGE_LIMIT) { state.loadedOnce = false; state.pollBusy = false; await loadInitial(); return; }

      const stick = nearBottom();
      let added = 0;
      list.forEach((m) => { if (addMessage(m)) added++; });
      (data.invitation_updates || []).forEach(updateInvitation);
      (data.request_updates || []).forEach(updateRequest);
      state.invSince = data.server_time || state.invSince;
      setBadge(data.unread_reply_count);
      if (added) {
        if (stick) { trimOldMessages(); scrollToBottom(); } else showNewPill();
      }
    } catch (_) {
      if (session !== state.session) return;
      state.pollFailures += 1;
      notice("Reconnecting to World Chat…", "error");
    } finally {
      if (session === state.session) state.pollBusy = false;
    }
  }

  /* ---- open-state polling: a single timer chain, never overlapping ---- */

  function stopPolling() { clearTimeout(state.pollTimer); state.pollTimer = null; }

  function schedulePoll(delay) {
    clearTimeout(state.pollTimer);
    state.pollTimer = setTimeout(async () => {
      state.pollTimer = null;
      if (!state.open || document.hidden) return;
      await pollOnce();
      if (document.querySelector("#worldChatPanel [data-unread-reply]")) rescanUnread();
      if (state.open && !document.hidden) schedulePoll(nextDelay());
    }, delay);
  }

  function nextDelay() { return Math.min(POLL_OPEN_MS * Math.pow(2, state.pollFailures), POLL_MAX_MS); }
  function startPolling() { if (state.pollTimer || !state.open || document.hidden) return; schedulePoll(POLL_OPEN_MS); }
  function pollNow() { if (!state.open || document.hidden) return; stopPolling(); pollOnce().then(() => { if (state.open && !document.hidden) schedulePoll(nextDelay()); }); }

  /* ------------------------------------------------------------ sending */

  function setComposerBusy(busy) {
    $("worldChatSend").disabled = busy;
    $("worldChatInput").readOnly = busy;
  }

  async function sendMessage(event) {
    event.preventDefault();
    if (state.sending || !state.authed) return;
    const input = $("worldChatInput");
    const body = input.value.trim();
    if (!body) return;

    const session = state.session;
    state.sending = true;
    setComposerBusy(true);
    try {
      const payload = { body };
      if (state.replyTo) payload.reply_to_id = state.replyTo.id;
      const data = await api("/world-chat/messages", { method: "POST", body: payload });
      if (session !== state.session) return;
      input.value = "";
      clearReply();
      if (data.message) addMessage(data.message);
      scrollToBottom();
      notice("");
    } catch (error) {
      if (session !== state.session) return;
      if (error.status === 404 && state.replyTo) clearReply();     // the message we were answering is gone
      notice(error.message || "Message could not be sent.", "error");   // the text stays in the box
    } finally {
      if (session === state.session) {
        state.sending = false;
        setComposerBusy(false);
        input.focus({ preventScroll: true });
      }
    }
  }

  function startReply(m) {
    state.replyTo = { id: m.id, name: senderName(m.sender, !!m.mine), body: snippet(m.body, 90) };
    $("worldChatReplyName").textContent = "Replying to " + state.replyTo.name;
    $("worldChatReplyText").textContent = state.replyTo.body;
    $("worldChatReplyPreview").classList.remove("hidden");
    $("worldChatInput").focus();
  }

  function clearReply() {
    state.replyTo = null;
    const preview = $("worldChatReplyPreview");
    if (preview) preview.classList.add("hidden");
  }

  /* --------------------------------------------------------- game invites */

  function toggleInviteForm(show) {
    const form = $("worldChatInviteForm");
    const next = typeof show === "boolean" ? show : form.classList.contains("hidden");
    form.classList.toggle("hidden", !next);
    $("worldChatInviteToggle").setAttribute("aria-expanded", String(next));
    if (next) $("worldChatInviteGame").focus();
  }

  async function submitInvitation(event) {
    event.preventDefault();
    if (!state.authed) return;
    const game = $("worldChatInviteGame").value.trim();
    const details = $("worldChatInviteDetails").value.trim();
    const max = Number.parseInt($("worldChatInviteMax").value, 10);
    if (!game) { notice("Tell people which game you want to play.", "error"); return; }
    if (!Number.isInteger(max) || max < 2 || max > 100) { notice("Choose between 2 and 100 players.", "error"); return; }

    const submit = $("worldChatInviteSubmit");
    const session = state.session;
    submit.disabled = true;
    try {
      const data = await api("/world-chat/invitations",
        { method: "POST", body: { game_type: game, details, max_participants: max } });
      if (session !== state.session) return;
      if (data.message) addMessage(data.message);
      $("worldChatInviteForm").reset();
      $("worldChatInviteMax").value = "4";
      toggleInviteForm(false);
      scrollToBottom();
      notice("Your game invitation is live.", "ok");
    } catch (error) {
      if (session !== state.session) return;
      notice(error.message || "Could not create the invitation.", "error");
    } finally {
      if (session === state.session) submit.disabled = false;
    }
  }

  /* ------------------------------------------------ unread replies to me */

  function clearTray() {
    const tray = $("worldChatReplies");
    if (!tray) return;
    tray.querySelectorAll("[data-unread-reply]").forEach((n) => { if (state.observer) state.observer.unobserve(n); });
    tray.replaceChildren();
    tray.classList.add("hidden");
  }

  function renderTray(replies, total) {
    clearTray();
    if (!replies.length) return;
    const tray = $("worldChatReplies");
    const head = el("div", "wc-replies-head");
    head.append(icon("reply", 13), document.createTextNode(
      total > replies.length ? replies.length + " of " + total + " new replies to you"
        : total + (total === 1 ? " new reply to you" : " new replies to you")));
    tray.append(head);

    replies.forEach((m) => {
      const row = el("button", "wc-reply-row");
      row.type = "button";
      row.dataset.unreadReply = String(m.id);
      row.append(el("strong", "", senderName(m.sender, false)), el("span", "wc-reply-snippet", snippet(m.body, 140)));
      if (m.reply_to) row.append(el("small", "", "to your message: " + snippet(m.reply_to.body, 80)));
      row.addEventListener("click", () => jumpTo(m.id));
      tray.append(row);
      observeUnread(row);
    });
    tray.classList.remove("hidden");
  }

  async function loadUnreadReplies() {
    if (!state.authed) return;
    const session = state.session;
    try {
      const data = await api("/world-chat/replies/unread");
      if (session !== state.session || !state.open) return;
      setBadge(data.count);
      renderTray(Array.isArray(data.replies) ? data.replies : [], Number(data.count) || 0);
    } catch (_) { /* the badge poll and message poll keep working */ }
  }

  /* "Seen" means: panel open, tab visible, nothing on top of it, and the reply actually on screen. */

  function observeUnread(node) {
    if (state.observer) state.observer.observe(node);
    else if (canSee()) queueRead(Number(node.dataset.unreadReply));   // very old browsers: open panel = seen
  }

  function onIntersect(entries) {
    if (!canSee()) return;
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      const enough = entry.intersectionRatio >= 0.6 || entry.intersectionRect.height >= 110;
      if (enough) queueRead(Number(entry.target.dataset.unreadReply));
    });
  }

  // observe() always delivers the current state once, so re-observing re-checks everything on screen.
  function rescanUnread() {
    if (!state.observer) return;
    state.observer.disconnect();
    document.querySelectorAll("#worldChatPanel [data-unread-reply]").forEach((n) => state.observer.observe(n));
  }

  function queueRead(id) {
    if (!id) return;
    state.pendingRead.add(id);
    clearTimeout(state.readTimer);
    state.readTimer = setTimeout(flushRead, READ_DEBOUNCE_MS);
  }

  async function flushRead() {
    clearTimeout(state.readTimer);
    state.readTimer = null;
    if (state.readBusy || !state.pendingRead.size || !state.authed) return;
    const ids = Array.from(state.pendingRead);
    state.pendingRead.clear();
    state.readBusy = true;
    const session = state.session;
    try {
      const data = await api("/world-chat/replies/read", { method: "POST", body: { message_ids: ids } });
      if (session !== state.session) return;
      ids.forEach(markSeenInDom);
      setBadge(data.count);
      // More unread replies than one page held? Pull the next batch (bounded).
      if (data.count > 0 && state.open && !document.querySelector("#worldChatPanel [data-unread-reply]") && state.trayRounds < MAX_TRAY_ROUNDS) {
        state.trayRounds += 1;
        loadUnreadReplies();
      }
    } catch (_) {
      if (session !== state.session) return;
      ids.forEach((id) => state.pendingRead.add(id));            // try again later; nothing is lost
      if (state.open) state.readTimer = setTimeout(flushRead, 8000);
    } finally {
      if (session === state.session) {
        state.readBusy = false;
        if (state.pendingRead.size && !state.readTimer) state.readTimer = setTimeout(flushRead, READ_DEBOUNCE_MS);
      }
    }
  }

  function markSeenInDom(id) {
    document.querySelectorAll('#worldChatPanel [data-unread-reply="' + id + '"]').forEach((node) => {
      if (state.observer) state.observer.unobserve(node);
      delete node.dataset.unreadReply;
      if (node.classList.contains("is-unread-reply")) {
        setTimeout(() => node.classList.remove("is-unread-reply"), 2500);    // let the highlight fade
        const tag = node.querySelector(".wc-msg-tag");
        if (tag) setTimeout(() => tag.remove(), 2500);
      }
    });
  }

  /* ------------------------------------------------------- session hooks */

  function resetAll() {
    clearTimeout(state.readTimer);
    clearTimeout(state.noticeTimer);
    state.readTimer = null;
    state.pendingRead.clear();
    state.loadedOnce = false;
    state.loading = false;
    state.pollBusy = false;
    state.badgeBusy = false;
    state.readBusy = false;
    state.pollFailures = 0;
    state.invSince = null;
    state.sending = false;
    resetMessages();
    clearTray();
    clearReply();
    notice("");
    const form = $("worldChatInviteForm");
    if (form) { form.reset(); $("worldChatInviteMax").value = "4"; }
    setComposerBusy(false);
    $("worldChatInput").value = "";
    setBadge(0);
  }

  // Called by social.js once the user is logged in (same pattern as onMessagingOpened).
  window.onWorldChatOpened = function () {
    bindOnce();
    if (state.open) closePanel(true);
    state.session += 1;
    stopPolling();
    stopBadgePolling();
    resetAll();
    state.authed = true;
    $("worldChatRoot").classList.remove("hidden");
    syncLauncherVisibility();
    refreshBadge();
    startBadgePolling();
  };

  // Called by social.js on logout or an expired session.
  window.onWorldChatClosed = function () {
    if (!state.ready) return;
    state.session += 1;
    stopPolling();
    stopBadgePolling();
    state.authed = false;
    if (state.open) closePanel(true);
    state.open = false;
    $("worldChatPanel").classList.add("hidden");
    $("worldChatRoot").classList.remove("is-open");
    $("worldChatRoot").classList.add("hidden");
    resetAll();
  };

  /* ------------------------------------------------- one-time listeners */

  function bindOnce() {
    if (state.ready) return;
    state.ready = true;

    if ("IntersectionObserver" in window) {
      state.observer = new IntersectionObserver(onIntersect, { threshold: [0, 0.25, 0.6, 1] });
    }

    const messagesScreen = $("messagesScreen");
    if (messagesScreen) new MutationObserver(syncLauncherVisibility).observe(messagesScreen, { attributes: true, attributeFilter: ["class"] });

    $("worldChatLauncher").addEventListener("click", togglePanel);
    $("worldChatClose").addEventListener("click", () => closePanel());
    $("worldChatComposer").addEventListener("submit", sendMessage);
    $("worldChatReplyCancel").addEventListener("click", () => { clearReply(); $("worldChatInput").focus(); });
    $("worldChatInviteToggle").addEventListener("click", () => toggleInviteForm());
    $("worldChatInviteCancel").addEventListener("click", () => toggleInviteForm(false));
    $("worldChatInviteForm").addEventListener("submit", submitInvitation);
    $("worldChatNewPill").addEventListener("click", scrollToBottom);

    // On the whole widget (not just the panel) so Escape also works while focus is on the launcher.
    $("worldChatRoot").addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !state.open) return;
      event.stopPropagation();
      if (!$("worldChatInviteForm").classList.contains("hidden")) toggleInviteForm(false);
      else closePanel();
    });

    let scrollQueued = false;
    messagesBox().addEventListener("scroll", () => {
      if (scrollQueued) return;
      scrollQueued = true;
      requestAnimationFrame(() => { scrollQueued = false; if (nearBottom()) hideNewPill(); });
    }, { passive: true });

    document.addEventListener("visibilitychange", () => {
      if (!state.authed) return;
      if (document.hidden) { stopPolling(); stopBadgePolling(); flushRead(); return; }
      if (state.open) { pollNow(); rescanUnread(); }
      else { refreshBadge(); startBadgePolling(); }
    });
  }

  // If the app was already opened before this script ran (fast session restore), catch up.
  const appScreen = $("appScreen");
  if (appScreen && !appScreen.classList.contains("hidden")) window.onWorldChatOpened();

  // Small public surface for other scripts; nothing here opens the panel on its own.
  window.openWorldChat = openPanel;
  window.closeWorldChat = () => closePanel();
  window.toggleWorldChat = togglePanel;
})();
