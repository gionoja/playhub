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
    pendingImage: null,  // { file, previewUrl }
    replyTo: null,
    theme: "default",
    typingTimer: null,
    lastTypingSent: 0,
    mediaRecorder: null,
    voiceChunks: [],
    recording: false,
    discardVoiceNote: false,
    stickerTrayOpen: false,
    blocked: false,
    blockedByMe: false
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
    stopTypingSignal();
    chat.list = [];
    chat.open = null;
    chat.unread = 0;
    chat.sending = false;

    clearPendingImage();
    if (chat.mediaRecorder && chat.mediaRecorder.state !== "inactive") chat.mediaRecorder.stop();
    chat.mediaRecorder = null;
    chat.voiceChunks = [];
    chat.recording = false;
    chat.replyTo = null;

    const view = document.getElementById("chatView");
    if (view) view.classList.add("hidden");

    ["conversationList", "chatMessages", "newChatList"].forEach(id => {
        const node = document.getElementById(id);
        if (node) node.replaceChildren();
    });

    closeModal("newChatModal");
    closeModal("reportUserModal");
    closeChatMenu();
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

        if (c.blocked) meta.append(el("small", "blocked-pill", "Blocked"));
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
    stopTypingSignal();
    discardVoiceRecording();
    clearPendingImage();
    chat.stickerTrayOpen = false;
    const stickerTray = document.getElementById("chatStickerTray");
    if (stickerTray) stickerTray.classList.add("hidden");

    chat.open = {
        user: { full_name: "", username: username, online: false },
        messages: [],
        lastId: 0,
        seenUpTo: 0,
        hasMore: false,
        canMessage: true,
        blocked: false,
        blockedByMe: false,
        loading: true,
        error: null,
        theme: "default",
        otherTyping: false
    };
    chat.replyTo = null;
    chat.theme = "default";

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
        chat.open.blocked = !!data.blocked;
        chat.open.blockedByMe = !!data.blocked_by_me;
        chat.open.seenUpTo = data.seen_up_to;
        chat.open.theme = data.theme || "default";
        chat.open.otherTyping = !!data.other_typing;
        chat.theme = chat.open.theme;
        chat.open.lastId = data.messages.length
            ? data.messages[data.messages.length - 1].id : 0;
        chat.open.loading = false;

        renderChat();
        applyChatTheme(chat.theme);
        const themeSelect = document.getElementById("chatTheme");
        if (themeSelect) themeSelect.value = chat.theme;
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
    stopTypingSignal();
    discardVoiceRecording();
    chat.open = null;
    chat.replyTo = null;

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

    if (m.reply_to) {
        const quote = el("div", "msg-reply-quote", (m.reply_to.mine ? "You: " : "Reply: ") + m.reply_to.text);
        quote.title = "Jump to replied message";
        quote.addEventListener("click", () => {
            const target = document.querySelector('#chatMessages .msg-row[data-id="' + m.reply_to.id + '"]');
            if (target) { target.scrollIntoView({ behavior: "smooth", block: "center" }); target.classList.add("msg-highlight"); setTimeout(() => target.classList.remove("msg-highlight"), 1200); }
        });
        bubble.append(quote);
    }

    if (m.image_url) {
        const link = el("button", "msg-image-link");
        link.type = "button";
        link.setAttribute("aria-label", "Open photo");
        const img = el("img", "msg-image");
        img.src = API_URL + m.image_url;
        img.alt = "Image message";
        img.loading = "lazy";
        img.addEventListener("load", () => scrollChatToBottom(false));
        link.addEventListener("click", () => {
            const all = Array.from(document.querySelectorAll("#chatMessages .msg-image"));
            openImageViewer(all.map(i => ({ url: i.src, caption: "" })), Math.max(0, all.indexOf(img)));
        });
        link.append(img); bubble.append(link);
    }

    if (m.audio_url) {
        const audio = document.createElement("audio");
        audio.className = "msg-audio";
        audio.controls = true;
        audio.preload = "metadata";
        audio.src = API_URL + m.audio_url;
        audio.setAttribute("aria-label", "Voice note");
        bubble.append(el("div", "voice-note-label", "🎙 Voice note"), audio);
    }

    const stickers = { heart: "💖", laugh: "😂", wow: "😮", sad: "🥺", celebrate: "🎉", thumbs_up: "👍", fire: "🔥", love: "🥰" };
    if (m.sticker && stickers[m.sticker]) bubble.append(el("div", "msg-sticker", stickers[m.sticker]));
    if (m.text) bubble.append(el("div", "msg-text", m.text));

    const timeText = new Date(m.created_at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    bubble.append(el("div", "msg-time", timeText + (m.edited ? " · edited" : "")));
    row.append(bubble);

    if (m.reactions && m.reactions.length) {
        const reactions = el("div", "msg-reactions");
        m.reactions.forEach(r => {
            const b = el("button", "msg-reaction" + (r.mine ? " selected" : ""), r.emoji + " " + r.count);
            b.type = "button"; b.setAttribute("aria-label", "Toggle " + r.emoji + " reaction");
            b.addEventListener("click", () => toggleMessageReaction(m.id, r.emoji));
            reactions.append(b);
        });
        row.append(reactions);
    }

    const actions = el("div", "msg-actions");
    const reply = el("button", null, "Reply"); reply.type = "button"; reply.addEventListener("click", () => setReplyTarget(m)); actions.append(reply);
    const react = el("button", null, "React"); react.type = "button"; react.addEventListener("click", () => showReactionPicker(m.id)); actions.append(react);
    if (m.mine && m.type === "TEXT") {
        const edit = el("button", null, "Edit"); edit.type = "button"; edit.addEventListener("click", () => editChatMessage(m)); actions.append(edit);
    }
    row.append(actions);
    return row;
}

function renderChat() {

    const c = chat.open;
    if (!c) return;

    document.getElementById("chatName").textContent = c.user.full_name || "@" + c.user.username;
    const blockAction = document.getElementById("chatBlockAction");
    if (blockAction) blockAction.textContent = c.blockedByMe ? "Unblock user" : "Block user";
    applyChatTheme(c.theme || chat.theme || "default");
    updateTypingIndicator(!!c.otherTyping);

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
    if (locked) {
        document.getElementById("chatLocked").textContent = c.blocked
            ? (c.blockedByMe ? "You blocked this user. Unblock them from chat options to message again." : "Messaging is unavailable because this user blocked you.")
            : "You can only message people you are friends with.";
    }
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
        chat.open.blocked = !!data.blocked;
        chat.open.blockedByMe = !!data.blocked_by_me;
        chat.open.seenUpTo = data.seen_up_to;
        chat.open.otherTyping = !!data.other_typing;
        chat.open.theme = data.theme || chat.open.theme || "default";
        chat.theme = chat.open.theme;

        appendMessages(data.messages);
        (data.updated_messages || []).forEach(replaceLocalMessage);
        updateTypingIndicator(chat.open.otherTyping);
        applyChatTheme(chat.theme);
        updateSeenLabel();

        const status = document.getElementById("chatStatus");
        status.textContent = data.other.online ? "Online" : "Offline";
        status.classList.toggle("online", !!data.other.online);

        const locked = !data.can_message;
        document.getElementById("chatComposer").classList.toggle("hidden", locked);
        document.getElementById("chatLocked").classList.toggle("hidden", !locked);
        if (locked) {
            document.getElementById("chatLocked").textContent = data.blocked
                ? (data.blocked_by_me ? "You blocked this user. Unblock them from chat options to message again." : "Messaging is unavailable because this user blocked you.")
                : "You can only message people you are friends with.";
        }
        const blockAction = document.getElementById("chatBlockAction");
        if (blockAction) blockAction.textContent = data.blocked_by_me ? "Unblock user" : "Block user";

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


/* ----------------------- block / report controls ------------------ */

function toggleChatMenu(event) {
    if (event) event.stopPropagation();
    const menu = document.getElementById("chatActionsMenu"), toggle = document.getElementById("chatActionsToggle");
    if (!menu || !toggle) return;
    const opening = menu.classList.contains("hidden");
    menu.classList.toggle("hidden", !opening); toggle.setAttribute("aria-expanded", String(opening));
}
function closeChatMenu() {
    const menu = document.getElementById("chatActionsMenu"), toggle = document.getElementById("chatActionsToggle");
    if (menu) menu.classList.add("hidden"); if (toggle) toggle.setAttribute("aria-expanded", "false");
}
document.addEventListener("click", event => {
    const menu = document.getElementById("chatActionsMenu");
    if (menu && !menu.classList.contains("hidden") && !event.target.closest(".chat-actions")) closeChatMenu();
});
document.addEventListener("keydown", event => { if (event.key === "Escape") closeChatMenu(); });

async function toggleBlockChatUser() {
    const c = chat.open; if (!c) return; closeChatMenu();
    const blocking = !c.blockedByMe;
    const promptText = blocking
        ? "Block @" + c.user.username + "? They will no longer be able to message you, and your friendship will be removed."
        : "Unblock @" + c.user.username + "? You can message them again if you are friends.";
    if (!confirm(promptText)) return;
    try {
        const result = await api("/users/" + encodeURIComponent(c.user.username) + "/block", { method: blocking ? "POST" : "DELETE" });
        showToast(result.message || (blocking ? "User blocked" : "User unblocked"));
        await openChat(c.user.username); loadConversations(true);
    } catch (error) { showToast(error.message || "Could not update block status"); }
}
function reportChatUser() {
    if (!chat.open) return; closeChatMenu();
    document.querySelectorAll('input[name="userReportReason"]').forEach(input => { input.checked = false; });
    document.getElementById("userReportDetails").value = "";
    const message = document.getElementById("userReportMessage"); message.classList.add("hidden"); message.textContent = "";
    document.getElementById("reportUserTitle").textContent = "Report @" + chat.open.user.username;
    document.getElementById("reportUserModal").classList.remove("hidden");
}
async function submitUserReport() {
    if (!chat.open) return;
    const reason = document.querySelector('input[name="userReportReason"]:checked')?.value;
    const details = document.getElementById("userReportDetails").value.trim();
    const message = document.getElementById("userReportMessage");
    if (!reason) { message.textContent = "Choose a reason before submitting."; message.classList.remove("hidden"); return; }
    const submit = document.getElementById("userReportSubmit"); submit.disabled = true;
    try {
        const result = await api("/users/" + encodeURIComponent(chat.open.user.username) + "/report", { method: "POST", body: { reason, details } });
        closeModal("reportUserModal"); showToast(result.message || "Report submitted for review");
    } catch (error) { message.textContent = error.message || "Could not submit the report."; message.classList.remove("hidden"); }
    finally { submit.disabled = false; }
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
            if (chat.replyTo) form.append("reply_to_id", String(chat.replyTo.id));
            options = { method: "POST", formData: form };
        } else {
            options = { method: "POST", body: { text: text, reply_to_id: chat.replyTo ? chat.replyTo.id : null } };
        }
        const message = await api("/conversations/" + encodeURIComponent(username) + "/messages", options);
        if (chat.open && chat.open.user.username === username) {
            input.value = ""; autosizeChatInput(); clearPendingImage(); clearReplyTarget();
            stopTypingSignal(); appendMessages([message]);
        }
    } catch (error) { showToast(error.message); }
    chat.sending = false;
    sendBtn.disabled = false;
    input.focus();
}

const CHAT_STICKERS = [
    { key: "heart", emoji: "💖", label: "Heart" }, { key: "laugh", emoji: "😂", label: "Laugh" },
    { key: "wow", emoji: "😮", label: "Wow" }, { key: "sad", emoji: "🥺", label: "Sad" },
    { key: "celebrate", emoji: "🎉", label: "Celebrate" }, { key: "thumbs_up", emoji: "👍", label: "Thumbs up" },
    { key: "fire", emoji: "🔥", label: "Fire" }, { key: "love", emoji: "🥰", label: "Love" }
];
const CHAT_REACTIONS = ["❤️", "😂", "👍", "😮", "😢", "🔥", "👏"];

function toggleStickerTray() {
    const tray = document.getElementById("chatStickerTray");
    if (!tray) return;
    if (!tray.childElementCount) {
        CHAT_STICKERS.forEach(sticker => {
            const b = el("button", "sticker-choice", sticker.emoji);
            b.type = "button"; b.title = sticker.label; b.setAttribute("aria-label", sticker.label);
            b.addEventListener("click", () => sendSticker(sticker.key)); tray.append(b);
        });
    }
    chat.stickerTrayOpen = !chat.stickerTrayOpen;
    tray.classList.toggle("hidden", !chat.stickerTrayOpen);
}

async function sendSticker(key) {
    const c = chat.open;
    if (!c || !c.canMessage || chat.sending) return;
    chat.sending = true;
    try {
        const m = await api("/conversations/" + encodeURIComponent(c.user.username) + "/messages", {
            method: "POST", body: { sticker: key, reply_to_id: chat.replyTo ? chat.replyTo.id : null }
        });
        appendMessages([m]); clearReplyTarget();
        chat.stickerTrayOpen = false; document.getElementById("chatStickerTray").classList.add("hidden");
    } catch (error) { showToast(error.message); }
    finally { chat.sending = false; }
}

function setReplyTarget(message) {
    chat.replyTo = { id: message.id, text: message.text || (message.image_url ? "Photo" : message.audio_url ? "Voice note" : message.sticker || "Message") };
    document.getElementById("chatReplyText").textContent = chat.replyTo.text;
    document.getElementById("chatReplyPreview").classList.remove("hidden");
    document.getElementById("chatInput").focus();
}
function clearReplyTarget() {
    chat.replyTo = null;
    const preview = document.getElementById("chatReplyPreview");
    if (preview) preview.classList.add("hidden");
}

async function toggleMessageReaction(messageId, emoji) {
    if (!chat.open) return;
    try {
        const updated = await api("/messages/" + messageId + "/reactions", { method: "POST", body: { emoji: emoji } });
        replaceLocalMessage(updated);
    } catch (error) { showToast(error.message); }
}
function showReactionPicker(messageId) {
    const picker = el("div", "msg-reaction-picker");
    CHAT_REACTIONS.forEach(emoji => {
        const b = el("button", null, emoji); b.type = "button";
        b.addEventListener("click", () => { picker.remove(); toggleMessageReaction(messageId, emoji); }); picker.append(b);
    });
    const row = document.querySelector('#chatMessages .msg-row[data-id="' + messageId + '"] .msg-actions');
    if (row) { const old = row.querySelector(".msg-reaction-picker"); if (old) old.remove(); row.append(picker); }
}
function replaceLocalMessage(updated) {
    if (!chat.open) return;
    const idx = chat.open.messages.findIndex(m => m.id === updated.id);
    if (idx >= 0) chat.open.messages[idx] = updated;
    const old = document.querySelector('#chatMessages .msg-row[data-id="' + updated.id + '"]');
    if (old) old.replaceWith(messageNode(updated));
    updateSeenLabel();
}
async function editChatMessage(message) {
    const edited = prompt("Edit your message", message.text || "");
    if (edited === null || edited.trim() === "" || edited.trim() === message.text) return;
    try {
        const updated = await api("/messages/" + message.id, { method: "PATCH", body: { text: edited.trim() } });
        replaceLocalMessage(updated);
    } catch (error) { showToast(error.message); }
}

function onChatInputChanged() {
    autosizeChatInput();
    const value = document.getElementById("chatInput").value.trim();
    if (value) sendTypingSignal(true); else stopTypingSignal();
}
function sendTypingSignal(typing) {
    const c = chat.open;
    if (!c || !c.canMessage) return;
    if (chat.typingTimer) clearTimeout(chat.typingTimer);
    const now = Date.now();
    if (typing && now - chat.lastTypingSent < 1200) {
        chat.typingTimer = setTimeout(() => sendTypingSignal(true), 1200 - (now - chat.lastTypingSent));
        return;
    }
    chat.lastTypingSent = now;
    api("/conversations/" + encodeURIComponent(c.user.username) + "/typing", { method: "POST", body: { typing: typing } }).catch(() => {});
    if (typing) chat.typingTimer = setTimeout(() => stopTypingSignal(), 3500);
}
function stopTypingSignal() {
    if (chat.typingTimer) clearTimeout(chat.typingTimer);
    chat.typingTimer = null;
    const c = chat.open;
    if (c && c.user && c.user.username) {
        api("/conversations/" + encodeURIComponent(c.user.username) + "/typing", { method: "POST", body: { typing: false } }).catch(() => {});
    }
}
function updateTypingIndicator(typing) {
    const node = document.getElementById("chatTyping");
    if (!node) return;
    node.textContent = (chat.open && chat.open.user.full_name ? chat.open.user.full_name : "Your friend") + " is typing…";
    node.classList.toggle("hidden", !typing);
}

async function changeChatTheme(theme) {
    if (!chat.open) return;
    try {
        const data = await api("/conversations/" + encodeURIComponent(chat.open.user.username) + "/preferences", { method: "PUT", body: { theme: theme } });
        chat.theme = data.theme; chat.open.theme = data.theme; applyChatTheme(data.theme);
    } catch (error) { showToast(error.message); }
}
function applyChatTheme(theme) {
    const panel = document.querySelector(".chat-panel");
    if (!panel) return;
    ["default", "ocean", "sunset", "forest", "lavender"].forEach(t => panel.classList.remove("theme-" + t));
    panel.classList.add("theme-" + (theme || "default"));
    const select = document.getElementById("chatTheme");
    if (select && select.value !== (theme || "default")) select.value = theme || "default";
}

function discardVoiceRecording() {
    if (chat.mediaRecorder) {
        chat.discardVoiceNote = true;
        if (chat.mediaRecorder.state !== "inactive") chat.mediaRecorder.stop();
    }
    chat.voiceChunks = [];
    chat.recording = false;
    chat.mediaRecorder = null;
    const btn = document.getElementById("chatVoiceBtn");
    if (btn) { btn.textContent = "🎙"; btn.classList.remove("recording"); btn.title = "Record voice note"; }
}

async function toggleVoiceRecording() {
    if (chat.recording && chat.mediaRecorder) {
        chat.mediaRecorder.stop();
        const btn = document.getElementById("chatVoiceBtn");
        btn.textContent = "🎙"; btn.classList.remove("recording");
        return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
        showToast("Voice recording is not supported by this browser. Try a recent browser over HTTPS."); return;
    }
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const preferred = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
        const mimeType = preferred.find(type => MediaRecorder.isTypeSupported(type));
        const recorder = mimeType ? new MediaRecorder(stream, { mimeType: mimeType }) : new MediaRecorder(stream);
        chat.mediaRecorder = recorder; chat.voiceChunks = []; chat.recording = true;
        recorder.ondataavailable = event => { if (event.data && event.data.size) chat.voiceChunks.push(event.data); };
        recorder.onerror = () => showToast("Voice note recording failed.");
        recorder.onstop = async () => {
            stream.getTracks().forEach(track => track.stop());
            chat.recording = false; chat.mediaRecorder = null;
            const btn = document.getElementById("chatVoiceBtn");
            if (btn) { btn.textContent = "🎙"; btn.classList.remove("recording"); btn.title = "Record voice note"; }
            const blob = new Blob(chat.voiceChunks, { type: recorder.mimeType || "audio/webm" });
            chat.voiceChunks = [];
            if (chat.discardVoiceNote) { chat.discardVoiceNote = false; return; }
            if (!blob.size) return;
            if (blob.size > 5 * 1024 * 1024) { showToast("Voice note exceeds the 5 MB limit. Please record a shorter note."); return; }
            await sendVoiceNote(blob);
        };
        recorder.start();
        const btn = document.getElementById("chatVoiceBtn");
        btn.textContent = "■"; btn.classList.add("recording"); btn.title = "Stop and send voice note";
        showToast("Recording voice note. Press the stop button to send.");
    } catch (error) { showToast("Microphone access was denied or is unavailable."); }
}
async function sendVoiceNote(blob) {
    const c = chat.open;
    if (!c || !c.canMessage) return;
    const form = new FormData();
    const ext = blob.type.includes("ogg") ? "ogg" : blob.type.includes("mp4") ? "mp4" : "webm";
    form.append("audio", blob, "voice-note." + ext);
    if (chat.replyTo) form.append("reply_to_id", String(chat.replyTo.id));
    try {
        const m = await api("/conversations/" + encodeURIComponent(c.user.username) + "/messages", { method: "POST", formData: form });
        appendMessages([m]); clearReplyTarget();
    } catch (error) { showToast(error.message); }
}


// Tap the picture or name at the top of a chat to open that person's profile
function openChatProfile() {

    if (chat.open) openUserProfile(chat.open.user.username);
}