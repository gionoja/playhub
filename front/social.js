/* =====================================================================
   PLAYHUB social features: people search, profiles, friend requests,
   friends. Everything here talks to the backend; nothing is stored
   only in the browser.
   ===================================================================== */

const social = {
    friends: [],
    suggestions: [],
    incoming: [],
    outgoing: [],
    results: null,          // null = not searching
    query: "",
    tab: "friends",
    loading: false,
    loadError: null,
    searching: false,
    searchError: null,
    searchSeq: 0,
    searchTimer: null,
    pollTimer: null,
    openProfile: null,      // username shown in the profile modal
    confirmRemove: null,
    busy: false
};


/* ----------------------------- icons ------------------------------ */

const ICON_PATHS = {
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    userPlus: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" x2="19" y1="8" y2="14"/><line x1="22" x2="16" y1="11" y2="11"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    userX: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="17" x2="22" y1="8" y2="13"/><line x1="22" x2="17" y1="8" y2="13"/>',
    alert: '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
    message: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
    inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>'
};

function iconNode(name, size) {
    const wrap = document.createElement("template");
    wrap.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" width="' + size +
        '" height="' + size + '" viewBox="0 0 24 24" fill="none" ' +
        'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
        'stroke-linejoin="round" aria-hidden="true">' +
        ICON_PATHS[name] + "</svg>";
    return wrap.content.firstChild;
}


/* --------------------------- DOM helpers -------------------------- */

// textContent keeps user-entered names from ever running as HTML
function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function actionButton(label, variant, onClick, iconName, disabled) {
    const b = el("button", "pbtn " + variant);
    b.type = "button";
    if (iconName) b.append(iconNode(iconName, 16));
    b.append(document.createTextNode(label));
    if (disabled) {
        b.disabled = true;
    } else {
        b.addEventListener("click", event => {
            event.stopPropagation();
            onClick();
        });
    }
    return b;
}

function avatarNode(user, size) {
    const a = el("div", "person-avatar" + (size === "large" ? " large" : ""));
    a.textContent = (user.full_name || "?").trim().charAt(0).toUpperCase();
    return a;
}

function stateBlock(iconName, title, text, retry) {
    const box = el("div", "empty-state compact");
    const ic = el("div", "empty-icon");
    ic.append(iconNode(iconName, 40));
    box.append(ic, el("h3", null, title));
    if (text) box.append(el("p", null, text));
    if (retry) {
        const b = actionButton("Try again", "primary", retry);
        b.style.marginTop = "16px";
        box.append(b);
    }
    return box;
}

function skeletonRows(count) {
    const wrap = el("div", "people-list");
    for (let i = 0; i < count; i++) {
        const row = el("div", "person-row skeleton");
        row.append(el("div", "person-avatar"), el("div", "skeleton-lines"));
        wrap.append(row);
    }
    return wrap;
}


/* ------------------------------ API ------------------------------- */

async function api(path, options = {}) {

    // app.js defines these. If they are missing, an older app.js is still being used.
    if (typeof TOKEN_KEY === "undefined" || typeof API_URL === "undefined") {
        throw new Error(
            "app.js is out of date. Replace it with the newest app.js, then press Ctrl+F5."
        );
    }

    const headers = {};
    const token = localStorage.getItem(TOKEN_KEY);

    if (token) headers["Authorization"] = "Bearer " + token;
    if (options.body) headers["Content-Type"] = "application/json";   // files set their own type

    let response;

    try {
        response = await fetch(API_URL + path, {
            method: options.method || "GET",
            headers: headers,
            body: options.formData || (options.body ? JSON.stringify(options.body) : undefined)
        });
    } catch (error) {
        throw new Error("Can't reach the PLAYHUB server");
    }

    let data = {};

    try {
        data = await response.json();
    } catch (error) {
        // empty or non-JSON body
    }

    if (response.status === 401) {
        showToast("Session expired. Please log in again.");
        logout();
        throw new Error("Session expired");
    }

    if (!response.ok) {
        throw new Error(data.message || "Something went wrong");
    }

    return data;
}


/* ------------------- hooks called from app.js --------------------- */

function onAppOpened() {

    resetSocialState();

    refreshRequests();

    social.pollTimer = setInterval(refreshRequests, 30000);

    if (typeof onMessagingOpened === "function") onMessagingOpened();

    if (typeof onFeedOpened === "function") onFeedOpened();
}

function onLoggedOut() {

    resetSocialState();

    if (typeof onMessagingClosed === "function") onMessagingClosed();

    if (typeof onFeedClosed === "function") onFeedClosed();

    const input = document.getElementById("userSearchInput");
    if (input) input.value = "";

    ["friendsContent", "notificationList", "userProfileBody"].forEach(id => {
        const node = document.getElementById(id);
        if (node) node.replaceChildren();
    });

    closeModal("userProfileModal");
    closeModal("notificationModal");
    updateBadges();
}

function resetSocialState() {

    clearInterval(social.pollTimer);
    clearTimeout(social.searchTimer);

    social.pollTimer = null;
    social.searchTimer = null;
    social.friends = [];
    social.suggestions = [];
    social.incoming = [];
    social.outgoing = [];
    social.results = null;
    social.query = "";
    social.tab = "friends";
    social.loading = false;
    social.loadError = null;
    social.searching = false;
    social.searchError = null;
    social.openProfile = null;
    social.confirmRemove = null;
    social.busy = false;
}

function onNotificationsOpened() {

    renderNotifications();

    refreshRequests();

    if (typeof markActivityRead === "function") markActivityRead();
}


/* ------------------------ loading the data ------------------------ */

function setRequests(data) {
    social.incoming = data.incoming || [];
    social.outgoing = data.outgoing || [];
}

async function refreshRequests() {

    try {
        setRequests(await api("/friends/requests"));
    } catch (error) {
        return;     // quiet: this also runs in the background
    }

    updateBadges();
    renderNotifications();

    if (typeof refreshActivity === "function") refreshActivity();

    const onFriendsScreen = document
        .getElementById("friendsScreen")
        .classList.contains("active");

    if (onFriendsScreen && !social.query) {
        renderFriendsContent();
    }
}

async function loadFriendsScreen() {

    social.loading = true;
    social.loadError = null;
    renderFriendsContent();

    try {
        const [friends, requests, suggestions] = await Promise.all([
            api("/friends"),
            api("/friends/requests"),
            api("/users/suggestions")
        ]);

        social.friends = friends;
        social.suggestions = suggestions;
        setRequests(requests);

    } catch (error) {
        social.loadError = error.message;
    }

    social.loading = false;
    renderFriendsContent();
    updateBadges();
}

// After any friend action: reload everything that might have changed
async function refreshSocialViews() {

    try {
        const [friends, requests, suggestions] = await Promise.all([
            api("/friends"),
            api("/friends/requests"),
            api("/users/suggestions")
        ]);

        social.friends = friends;
        social.suggestions = suggestions;
        setRequests(requests);

    } catch (error) {
        // keep what we have
    }

    if (social.query) {
        await runSearch(social.query, true);
    } else {
        renderFriendsContent();
    }

    updateBadges();
    renderNotifications();

    if (social.openProfile) {
        await loadProfileModal(social.openProfile, true);
    }
}

function updateBadges() {

    const count = social.incoming.length;

    const activity = typeof unreadActivityCount === "function" ? unreadActivityCount() : 0;

    const bell = document.getElementById("notifBadge");
    if (bell) bell.classList.toggle("hidden", count + activity === 0);

    const navBadge = document.getElementById("navFriendsBadge");
    if (navBadge) navBadge.classList.toggle("hidden", count === 0);

    const requestsPill = document.getElementById("requestsCount");
    if (requestsPill) {
        requestsPill.textContent = count;
        requestsPill.classList.toggle("hidden", count === 0);
    }

    const friendsPill = document.getElementById("friendsCount");
    if (friendsPill) {
        friendsPill.textContent = social.friends.length;
        friendsPill.classList.toggle("hidden", social.friends.length === 0);
    }
}


/* ----------------------------- search ----------------------------- */

function onUserSearchInput() {

    clearTimeout(social.searchTimer);

    const q = document
        .getElementById("userSearchInput")
        .value.trim().replace(/^@/, "");

    if (q.length < 2) {
        social.query = "";
        social.results = null;
        social.searching = false;
        social.searchError = null;
        social.searchSeq++;
        renderFriendsContent();
        return;
    }

    social.query = q;
    social.searching = true;
    social.searchError = null;
    renderFriendsContent();

    social.searchTimer = setTimeout(() => runSearch(q), 350);
}

async function runSearch(q, silent) {

    const seq = ++social.searchSeq;

    if (!silent) {
        social.searching = true;
        social.searchError = null;
        renderFriendsContent();
    }

    try {
        const results = await api("/users/search?q=" + encodeURIComponent(q));

        if (seq !== social.searchSeq) return;    // a newer search replaced this one

        social.results = results;
        social.searchError = null;

    } catch (error) {
        if (seq !== social.searchSeq) return;
        social.searchError = error.message;
    }

    social.searching = false;
    renderFriendsContent();
}

function setFriendsTab(tab) {
    social.tab = tab;
    renderFriendsContent();
}


/* ---------------------- friends screen render --------------------- */

function personRow(user) {

    const row = el("div", "person-row");
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.addEventListener("click", () => openUserProfile(user.username));
    row.addEventListener("keydown", event => {
        if (event.key === "Enter") openUserProfile(user.username);
    });

    const info = el("div", "person-info");
    info.append(
        el("strong", null, user.full_name),
        el("small", null, "@" + user.username)
    );

    const actions = el("div", "person-actions");
    relationButtons(user).forEach(b => actions.append(b));

    row.append(avatarNode(user), info, actions);

    return row;
}

function peopleList(users) {
    const list = el("div", "people-list");
    users.forEach(u => list.append(personRow(u)));
    return list;
}

function sectionTitle(text) {
    return el("div", "list-title", text);
}

function renderFriendsContent() {

    const box = document.getElementById("friendsContent");
    const tabs = document.getElementById("friendsTabs");

    if (!box) return;

    box.replaceChildren();

    const searchMode = social.query.length >= 2;

    tabs.classList.toggle("hidden", searchMode);

    document.getElementById("tabFriends")
        .classList.toggle("active", social.tab === "friends");
    document.getElementById("tabRequests")
        .classList.toggle("active", social.tab === "requests");

    // ---- search results
    if (searchMode) {

        box.append(sectionTitle("Search results"));

        if (social.searching && !social.results) {
            box.append(skeletonRows(3));
        } else if (social.searchError) {
            box.append(stateBlock("alert", "Search failed", social.searchError,
                () => runSearch(social.query)));
        } else if (social.results && social.results.length === 0) {
            box.append(stateBlock("search", "No one found",
                'No registered PLAYHUB user matches "' + social.query + '".'));
        } else if (social.results) {
            box.append(peopleList(social.results));
        }

        return;
    }

    // ---- loading / error for the tabs
    if (social.loading) {
        box.append(skeletonRows(3));
        return;
    }

    if (social.loadError) {
        box.append(stateBlock("alert", "Couldn't load your friends",
            social.loadError, loadFriendsScreen));
        return;
    }

    // ---- friends tab
    if (social.tab === "friends") {

        if (social.friends.length === 0) {
            box.append(stateBlock("users", "No friends yet",
                "Send a friend request to someone below, or search for people above."));
        } else {
            box.append(peopleList(social.friends));
        }

        if (social.suggestions.length) {
            box.append(sectionTitle("People you may know"),
                peopleList(social.suggestions));
        }

        return;
    }

    // ---- requests tab
    if (social.incoming.length === 0 && social.outgoing.length === 0) {
        box.append(stateBlock("inbox", "No pending requests",
            "Friend requests you send and receive will show up here."));
        return;
    }

    if (social.incoming.length) {
        box.append(sectionTitle("Received"), peopleList(social.incoming));
    }

    if (social.outgoing.length) {
        box.append(sectionTitle("Sent"), peopleList(social.outgoing));
    }
}


/* ------------------- the right button for each state -------------- */

function relationButtons(user) {

    switch (user.relationship) {

        case "none":
            return [actionButton("Add Friend", "primary",
                () => friendAction("add", user), "userPlus")];

        case "request_sent":
            return [
                actionButton("Request Sent", "ghost", null, null, true),
                actionButton("Cancel", "ghost", () => friendAction("cancel", user))
            ];

        case "request_received":
            return [
                actionButton("Accept", "primary", () => friendAction("accept", user), "check"),
                actionButton("Reject", "ghost", () => friendAction("reject", user))
            ];

        case "friends":
            return [
                actionButton("Message", "primary",
                    () => startChat(user.username), "message"),
                actionButton("Friends", "ghost", null, "check", true)
            ];

        default:
            return [];
    }
}

// Opens a chat, or explains clearly if the messaging files aren't all in place
function startChat(username) {

    if (typeof openChat !== "function" || !document.getElementById("chatView")) {
        showToast(
            "Messaging files are missing or old. Put messages.js and the newest " +
            "index.html in your frontend folder, then press Ctrl+F5."
        );
        return;
    }

    openChat(username);
}


async function friendAction(kind, user) {

    if (social.busy) return;
    social.busy = true;

    try {

        if (kind === "add") {
            await api("/friends/requests", {
                method: "POST",
                body: { username: user.username }
            });
            showToast("Friend request sent to " + user.full_name);
        }

        if (kind === "accept") {
            await api("/friends/requests/" + user.request_id + "/accept", { method: "POST" });
            showToast("You and " + user.full_name + " are now friends");
        }

        if (kind === "reject") {
            await api("/friends/requests/" + user.request_id + "/reject", { method: "POST" });
            showToast("Request rejected");
        }

        if (kind === "cancel") {
            await api("/friends/requests/" + user.request_id + "/cancel", { method: "POST" });
            showToast("Request cancelled");
        }

        if (kind === "remove") {
            await api("/friends/" + encodeURIComponent(user.username), { method: "DELETE" });
            showToast(user.full_name + " removed from your friends");
        }

    } catch (error) {
        showToast(error.message);
    }

    social.confirmRemove = null;
    social.busy = false;

    await refreshSocialViews();
}


/* --------------------------- profile modal ------------------------ */

function openUserProfile(username) {

    social.openProfile = username;
    social.confirmRemove = null;

    document.getElementById("userProfileModal").classList.remove("hidden");

    loadProfileModal(username);
}

function closeUserProfile() {
    social.openProfile = null;
    social.confirmRemove = null;
    closeModal("userProfileModal");
}

async function loadProfileModal(username, silent) {

    const body = document.getElementById("userProfileBody");

    if (!silent) {
        body.replaceChildren(skeletonRows(2));
    }

    try {
        const profile = await api("/users/" + encodeURIComponent(username));

        if (social.openProfile !== username) return;   // closed or changed meanwhile

        renderProfileModal(profile);

    } catch (error) {

        if (social.openProfile !== username) return;

        body.replaceChildren(stateBlock("alert", "Couldn't load this profile",
            error.message, () => loadProfileModal(username)));
    }
}

function renderProfileModal(p) {

    const body = document.getElementById("userProfileBody");
    body.replaceChildren();

    const top = el("div", "profile-top");
    top.append(avatarNode(p, "large"), el("h2", null, p.full_name),
        el("p", "profile-handle", "@" + p.username));

    if (p.bio) top.append(el("p", "profile-bio", p.bio));

    if (p.joined) {
        const when = new Date(p.joined).toLocaleDateString(undefined,
            { month: "short", year: "numeric" });
        top.append(el("p", "profile-joined", "Joined " + when));
    }

    body.append(top);

    const stats = el("div", "profile-stats");
    [
        [p.friends_count, "Friends"],
        [p.stats.games_played, "Games played"],
        [p.stats.wins, "Wins"]
    ].forEach(([value, label]) => {
        const cell = el("div", "stat-cell");
        cell.append(el("strong", null, String(value)), el("small", null, label));
        stats.append(cell);
    });
    body.append(stats);

    // ---- actions for this relationship
    const actions = el("div", "profile-actions");

    if (p.relationship === "self") {
        actions.append(actionButton("Go to my settings", "ghost", () => {
            closeUserProfile();
            showScreen("profile");
        }));

    } else if (p.relationship === "friends" && social.confirmRemove === p.username) {

        actions.append(
            el("p", "confirm-text", "Remove " + p.full_name + " from your friends?"),
            actionButton("Yes, remove", "danger", () => friendAction("remove", p), "userX"),
            actionButton("Keep friend", "ghost", () => {
                social.confirmRemove = null;
                renderProfileModal(p);
            })
        );

    } else {
        relationButtons(p).forEach(b => actions.append(b));

        if (p.relationship === "friends") {
            actions.append(actionButton("Remove friend", "ghost", () => {
                social.confirmRemove = p.username;
                renderProfileModal(p);
            }));
        }
    }

    body.append(actions);

    // ---- their friends
    body.append(sectionTitle("Friends"));

    if (p.friends.length === 0) {
        body.append(el("p", "muted-line", "No friends to show yet."));
    } else {
        const chips = el("div", "friend-chips");
        p.friends.forEach(f => {
            const chip = el("button", "friend-chip");
            chip.type = "button";
            chip.append(avatarNode(f), el("span", null, f.full_name));
            chip.addEventListener("click", () => openUserProfile(f.username));
            chips.append(chip);
        });
        body.append(chips);
    }

    if (typeof renderProfilePosts === "function") renderProfilePosts(p);
}


/* ---------------------- notifications (bell) ---------------------- */

function renderNotifications() {

    const list = document.getElementById("notificationList");
    const empty = document.getElementById("notificationEmpty");

    if (!list || !empty) return;

    list.replaceChildren();

    social.incoming.forEach(user => {

        const item = el("div", "notice-item");
        item.append(avatarNode(user));

        const text = el("div", "notice-text");
        const line = el("div");
        line.append(el("strong", null, user.full_name),
            document.createTextNode(" sent you a friend request"));
        text.append(line);

        const actions = el("div", "notice-actions");
        actions.append(
            actionButton("Accept", "primary", () => friendAction("accept", user), "check"),
            actionButton("Reject", "ghost", () => friendAction("reject", user))
        );
        text.append(actions);

        item.append(text);
        item.addEventListener("click", () => {
            closeModal("notificationModal");
            openUserProfile(user.username);
        });

        list.append(item);
    });

    const activity = typeof appendActivityNotifications === "function"
        ? appendActivityNotifications(list) : 0;

    empty.classList.toggle("hidden", social.incoming.length + activity > 0);
}