/* =====================================================================
   PLAYHUB messaging: conversation list, chat window, text and image
   messages, unread badges. Friends only. All data lives on the server.
   ===================================================================== */

const chat = {
    list: [],
    listLoading: false,
    listError: null,
    unread: 0,
    unreadTimer: null,
    open: null,         // { user, messages, lastId, seenUpTo, hasMore, canMessage }
    pollTimer: null,
    sending: false,
    pendingImage: null  // { file, previewUrl }
};

const CHAT_ICONS = {
    send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
    image: '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
    back: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
    compose: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M12 7v6"/><path d="M9 10h6"/>',
    message: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>'
};

function chatIcon(name, size) {
    const t = document.createElement("template");
    t.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size +
        '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        CHAT_ICONS[name] + "</svg>";
    return t.content.firstChild;
}

const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const MAX_IMAGE_MB = 5;


/* ------------------- hooks called from social.js ------------------ */

function onMessagingOpened() {

    chat.unread = 0;

    fetchUnread();

    clearInterval(chat.unreadTimer);
        chat.unreadTimer = setInterval(() => {
        if (!document.hidden) fetchUnread();
    }, 10000);
}

function onMessagingClosed() {

    clearInterval(chat.unreadTimer);
    clearInterval(chat.pollTimer);

    chat.unreadTimer = null;
    chat.pollTimer = null;
    chat.list = [];
    chat.open = null;
    chat.unread = 0;
    chat.sending = false;

    clearPendingImage();

    const view = document.getElementById("chatView");
    if (view) view.classList.add("hidden");

    ["conversationList", "chatMessages", "newChatList"].forEach(id => {
        const node = document.getElementById(id);
        if (node) node.replaceChildren();
    });

    closeModal("newChatModal");
    setUnreadBadge(0);
}


/* ------------------------- unread + list -------------------------- */

function setUnreadBadge(count) {
    const badge = document.getElementById("navMessagesBadge");
    if (badge) badge.classList.toggle("hidden", count === 0);
}

async function fetchUnread() {

    try {
        const data = await api("/messages/unread-count");

        const changed = data.count !== chat.unread;

        chat.unread = data.count;
        setUnreadBadge(data.count);

        const onMessages = document
            .getElementById("messagesScreen")
            .classList.contains("active");

        if (changed && onMessages && !chat.open) {
            loadConversations(true);
        }

    } catch (error) {
        // background check: stay quiet
    }
}

async function loadConversations(silent) {

    if (!silent) {
        chat.listLoading = true;
        chat.listError = null;
        renderConversations();
    }

    try {
        chat.list = await api("/conversations");
        chat.listError = null;
    } catch (error) {
        chat.listError = error.message;
    }

    chat.listLoading = false;
    renderConversations();
}

function shortTime(iso) {

    const d = new Date(iso);
    const now = new Date();

    if (d.toDateString() === now.toDateString()) {
        return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    }

    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function avatarWithStatus(user) {

    const wrap = el("div", "avatar-wrap");
    wrap.append(avatarNode(user));

    if (user.online) wrap.append(el("span", "online-dot"));

    return wrap;
}

function renderConversations() {

    const box = document.getElementById("conversationList");
    const empty = document.getElementById("messagesEmpty");

    if (!box || !empty) return;

    box.replaceChildren();

    const showEmpty =
        !chat.listLoading && !chat.listError && chat.list.length === 0;

    empty.classList.toggle("hidden", !showEmpty);

    if (chat.listLoading) {
        box.append(skeletonRows(3));
        return;
    }

    if (chat.listError) {
        box.append(stateBlock("alert", "Couldn't load your messages",
            chat.listError, () => loadConversations()));
        return;
    }

    const list = el("div", "people-list");

    chat.list.forEach(c => {

        const row = el("div", "person-row" + (c.unread ? " unread" : ""));
        row.tabIndex = 0;
        row.setAttribute("role", "button");
        row.addEventListener("click", () => openChat(c.user.username));
        row.addEventListener("keydown", e => {
            if (e.key === "Enter") openChat(c.user.username);
        });

        const info = el("div", "person-info");
        const preview = (c.last.mine ? "You: " : "") + c.last.text;
        info.append(el("strong", null, c.user.full_name), el("small", "preview", preview));

        const meta = el("div", "conv-meta");
        meta.append(el("small", null, shortTime(c.last.created_at)));

        if (c.unread) meta.append(el("span", "unread-pill", String(c.unread)));

        row.append(avatarWithStatus(c.user), info, meta);
        list.append(row);
    });

    box.append(list);
}


/* ---------------------- start a new conversation ------------------ */

async function openNewMessage() {

    const modal = document.getElementById("newChatModal");
    const box = document.getElementById("newChatList");

    modal.classList.remove("hidden");
    box.replaceChildren(skeletonRows(3));

    try {
        const friends = await api("/friends");

        box.replaceChildren();

        if (friends.length === 0) {
            const block = stateBlock("users", "No friends to message yet",
                "You can message people once they accept your friend request.");
            const go = actionButton("Find friends", "primary", () => {
                closeModal("newChatModal");
                showScreen("friends");
            });
            go.style.marginTop = "16px";
            block.append(go);
            box.append(block);
            return;
        }

        const list = el("div", "people-list");

        friends.forEach(f => {
            const row = el("div", "person-row");
            row.tabIndex = 0;
            row.setAttribute("role", "button");

            const go = () => {
                closeModal("newChatModal");
                openChat(f.username);
            };
            row.addEventListener("click", go);
            row.addEventListener("keydown", e => { if (e.key === "Enter") go(); });

            const info = el("div", "person-info");
            info.append(el("strong", null, f.full_name), el("small", null, "@" + f.username));

            row.append(avatarNode(f), info);
            list.append(row);
        });

        box.append(list);

    } catch (error) {
        box.replaceChildren(stateBlock("alert", "Couldn't load your friends",
            error.message, openNewMessage));
    }
}


/* ----------------------------- chat view -------------------------- */

async function openChat(username) {

    closeModal("userProfileModal");
    closeModal("notificationModal");
    social.openProfile = null;

    clearInterval(chat.pollTimer);
    clearPendingImage();

    chat.open = {
        user: { full_name: "", username: username, online: false },
        messages: [],
        lastId: 0,
        seenUpTo: 0,
        hasMore: false,
        canMessage: true,
        loading: true,
        error: null
    };

    document.getElementById("chatInput").value = "";
    autosizeChatInput();

    document.getElementById("chatView").classList.remove("hidden");
    renderChat();

    try {
        const data = await api(
            "/conversations/" + encodeURIComponent(username) + "/messages"
        );

        if (!chat.open || chat.open.user.username !== username) return;

        chat.open.user = data.other;
        chat.open.messages = data.messages;
        chat.open.hasMore = data.has_more;
        chat.open.canMessage = data.can_message;
        chat.open.seenUpTo = data.seen_up_to;
        chat.open.lastId = data.messages.length
            ? data.messages[data.messages.length - 1].id : 0;
        chat.open.loading = false;

        renderChat();
        scrollChatToBottom(true);

                chat.pollTimer = setInterval(() => {
            if (!document.hidden) pollChat();
        }, 3000);

        fetchUnread();

    } catch (error) {

        if (!chat.open || chat.open.user.username !== username) return;

        chat.open.loading = false;
        chat.open.error = error.message;
        renderChat();
    }
}

function closeChat() {

    clearInterval(chat.pollTimer);
    chat.pollTimer = null;
    chat.open = null;

    clearPendingImage();

    document.getElementById("chatView").classList.add("hidden");

    loadConversations(true);
    fetchUnread();
}

function dayLabel(iso) {
    const d = new Date(iso);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);

    if (d.toDateString() === today.toDateString()) return "Today";
    if (d.toDateString() === yesterday.toDateString()) return "Yesterday";

    return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function messageNode(m) {

    const row = el("div", "msg-row " + (m.mine ? "mine" : "theirs"));
    row.dataset.id = m.id;

    const bubble = el("div", "msg-bubble" + (m.image_url ? " has-image" : ""));

    if (m.image_url) {
        const link = el("a", "msg-image-link");
        link.href = API_URL + m.image_url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";

        const img = el("img", "msg-image");
        img.src = API_URL + m.image_url;
        img.alt = "Image message";
        img.loading = "lazy";
        img.addEventListener("load", () => scrollChatToBottom(false));
        link.append(img);
        bubble.append(link);
    }

    if (m.text) bubble.append(el("div", "msg-text", m.text));

    bubble.append(el("div", "msg-time",
        new Date(m.created_at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })));

    row.append(bubble);

    return row;
}

function renderChat() {

    const c = chat.open;
    if (!c) return;

    document.getElementById("chatName").textContent = c.user.full_name || "@" + c.user.username;

    const status = document.getElementById("chatStatus");
    status.textContent = c.loading ? "" : (c.user.online ? "Online" : "Offline");
    status.classList.toggle("online", !!c.user.online && !c.loading);

        fillAvatar(document.getElementById("chatAvatar"), {
        full_name: c.user.full_name || c.user.username,
        avatar_url: c.user.avatar_url
    });

    const box = document.getElementById("chatMessages");
    box.replaceChildren();

    if (c.loading) {
        box.append(skeletonRows(3));
    } else if (c.error) {
        box.append(stateBlock("alert", "Couldn't load this conversation", c.error,
            () => openChat(c.user.username)));
    } else if (c.messages.length === 0) {
        box.append(stateBlock("message", "No messages yet",
            c.canMessage ? "Say hello to " + (c.user.full_name || "your friend") + "."
                         : "You can only message people you are friends with."));
    } else {

        if (c.hasMore) {
            const more = actionButton("Load earlier messages", "ghost", loadEarlier);
            more.classList.add("load-more");
            box.append(more);
        }

        let lastDay = "";

        c.messages.forEach(m => {
            const day = new Date(m.created_at).toDateString();
            if (day !== lastDay) {
                box.append(el("div", "day-divider", dayLabel(m.created_at)));
                lastDay = day;
            }
            box.append(messageNode(m));
        });

        updateSeenLabel();
    }

    const locked = !c.loading && !c.error && !c.canMessage;

    document.getElementById("chatComposer").classList.toggle("hidden", locked || !!c.error);
    document.getElementById("chatLocked").classList.toggle("hidden", !locked);
}

function updateSeenLabel() {

    const c = chat.open;
    const box = document.getElementById("chatMessages");

    box.querySelectorAll(".seen-label").forEach(n => n.remove());

    const mine = c.messages.filter(m => m.mine);
    if (!mine.length) return;

    const last = mine[mine.length - 1];

    if (last.id <= c.seenUpTo) {
        const row = box.querySelector('.msg-row[data-id="' + last.id + '"]');
        if (row) row.append(el("div", "seen-label", "Seen"));
    }
}

function scrollChatToBottom(force) {

    const box = document.getElementById("chatMessages");
    if (!box) return;

    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;

    if (force || nearBottom) {
        box.scrollTop = box.scrollHeight;
    }
}

function appendMessages(list) {

    const c = chat.open;
    if (!c || list.length === 0) return;

    const box = document.getElementById("chatMessages");
    const wasEmpty = c.messages.length === 0;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;

    let prevDay = c.messages.length
        ? new Date(c.messages[c.messages.length - 1].created_at).toDateString()
        : "";

    const fresh = list.filter(m => !c.messages.some(x => x.id === m.id));

    fresh.forEach(m => {
        c.messages.push(m);
        c.lastId = Math.max(c.lastId, m.id);
    });

    if (wasEmpty) {
        renderChat();
    } else {
        fresh.forEach(m => {
            const day = new Date(m.created_at).toDateString();
            if (day !== prevDay) {
                box.append(el("div", "day-divider", dayLabel(m.created_at)));
                prevDay = day;
            }
            box.append(messageNode(m));
        });

        updateSeenLabel();
    }

    scrollChatToBottom(nearBottom || fresh.some(m => m.mine));
}

async function pollChat() {

    const c = chat.open;
    if (!c || c.loading || c.error) return;

    const username = c.user.username;

    try {
        const data = await api(
            "/conversations/" + encodeURIComponent(username) +
            "/messages?after_id=" + c.lastId
        );

        if (!chat.open || chat.open.user.username !== username) return;

        chat.open.user = data.other;
        chat.open.canMessage = data.can_message;
        chat.open.seenUpTo = data.seen_up_to;

        appendMessages(data.messages);
        updateSeenLabel();

        const status = document.getElementById("chatStatus");
        status.textContent = data.other.online ? "Online" : "Offline";
        status.classList.toggle("online", !!data.other.online);

        const locked = !data.can_message;
        document.getElementById("chatComposer").classList.toggle("hidden", locked);
        document.getElementById("chatLocked").classList.toggle("hidden", !locked);

    } catch (error) {
        // temporary connection problem: try again on the next tick
    }
}

async function loadEarlier() {

    const c = chat.open;
    if (!c || !c.messages.length) return;

    const username = c.user.username;
    const box = document.getElementById("chatMessages");
    const oldHeight = box.scrollHeight;

    try {
        const data = await api(
            "/conversations/" + encodeURIComponent(username) +
            "/messages?before_id=" + c.messages[0].id
        );

        if (!chat.open || chat.open.user.username !== username) return;

        chat.open.messages = data.messages.concat(chat.open.messages);
        chat.open.hasMore = data.has_more;

        renderChat();

        box.scrollTop = box.scrollHeight - oldHeight;     // keep the reader's place

    } catch (error) {
        showToast(error.message);
    }
}


/* ------------------------------ sending --------------------------- */

function autosizeChatInput() {
    const input = document.getElementById("chatInput");
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 120) + "px";
}

function onChatInputKey(event) {

    // Enter sends, Shift+Enter makes a new line
    if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
    }
}

function onImagePicked(event) {

    const file = event.target.files[0];
    event.target.value = "";     // lets the same file be picked again later

    if (!file) return;

    if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
        showToast("Only JPG, PNG, GIF or WebP images are allowed");
        return;
    }

    if (file.size > MAX_IMAGE_MB * 1024 * 1024) {
        showToast("That image is too large. The limit is " + MAX_IMAGE_MB + " MB.");
        return;
    }

    clearPendingImage();

    chat.pendingImage = { file: file, previewUrl: URL.createObjectURL(file) };

    document.getElementById("chatPreviewImg").src = chat.pendingImage.previewUrl;
    document.getElementById("chatImagePreview").classList.remove("hidden");

    document.getElementById("chatInput").focus();
}

function clearPendingImage() {

    if (chat.pendingImage) {
        URL.revokeObjectURL(chat.pendingImage.previewUrl);
        chat.pendingImage = null;
    }

    const preview = document.getElementById("chatImagePreview");
    if (preview) preview.classList.add("hidden");
}

async function sendMessage() {

    const c = chat.open;

    if (!c || chat.sending || !c.canMessage) return;

    const input = document.getElementById("chatInput");
    const text = input.value.trim();
    const image = chat.pendingImage;

    if (!text && !image) return;

    chat.sending = true;

    const sendBtn = document.getElementById("chatSend");
    sendBtn.disabled = true;

    const username = c.user.username;

    try {

        let options;

        if (image) {
            const form = new FormData();
            form.append("image", image.file);
            if (text) form.append("text", text);
            options = { method: "POST", formData: form };
        } else {
            options = { method: "POST", body: { text: text } };
        }

        const message = await api(
            "/conversations/" + encodeURIComponent(username) + "/messages", options
        );

        if (chat.open && chat.open.user.username === username) {
            input.value = "";
            autosizeChatInput();
            clearPendingImage();
            appendMessages([message]);
        }

    } catch (error) {
        showToast(error.message);      // the typed text stays so nothing is lost
    }

    chat.sending = false;
    sendBtn.disabled = false;
    input.focus();
}


// Tap the picture or name at the top of a chat to open that person's profile
function openChatProfile() {

    if (chat.open) openUserProfile(chat.open.user.username);
}