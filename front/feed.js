/* =====================================================================
   PLAYHUB feed: posts, animated likes, comments and stories.
   Everything is stored on the server and filtered by friendship there.
   Keeps the original function names used by index.html
   (openPostModal, createPost, likePost, openComments, addComment ...).
   ===================================================================== */

const feedState = {
    loading: false,
    loadingMore: false,
    error: null,
    hasMore: false,
    posting: false,
    comments: [],
    commentsLoading: false,
    commentsError: null,
    stories: [],
    storiesError: null,
    notifs: [],
    unread: 0
};

const postStore = new Map();      // post id -> latest data, shared by feed and profile cards
let feedPreviewUrl = null;
let storyFile = null;
let storyPreviewUrl = null;

const FEED_ICONS = {
    dots: '<circle cx="12" cy="5" r="1.7" fill="currentColor"/><circle cx="12" cy="12" r="1.7" fill="currentColor"/><circle cx="12" cy="19" r="1.7" fill="currentColor"/>',
    pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
    bookmark: '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    eyeOff: '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/>',
    flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/>',
    video: '<path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
    left: '<path d="m15 18-6-6 6-6"/>',
    right: '<path d="m9 18 6-6-6-6"/>',
    zoomIn: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/><line x1="11" x2="11" y1="8" y2="14"/><line x1="8" x2="14" y1="11" y2="11"/>',
    zoomOut: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/><line x1="8" x2="14" y1="11" y2="11"/>',
    heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
    comment: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
    image: '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    alert: '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
    lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'
};

function feedIcon(name, size) {
    const t = document.createElement("template");
    t.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size +
        '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        FEED_ICONS[name] + "</svg>";
    return t.content.firstChild;
}

const FEED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const FEED_MAX_MB = 5;

function checkImageFile(file) {

    if (!FEED_IMAGE_TYPES.includes(file.type)) {
        showToast("Only JPG, PNG, GIF or WebP images are allowed");
        return false;
    }

    if (file.size > FEED_MAX_MB * 1024 * 1024) {
        showToast("That image is too large. The limit is " + FEED_MAX_MB + " MB.");
        return false;
    }

    return true;
}

function timeAgo(iso) {

    const seconds = (Date.now() - new Date(iso).getTime()) / 1000;

    if (seconds < 60) return "Just now";
    if (seconds < 3600) return Math.floor(seconds / 60) + "m";
    if (seconds < 86400) return Math.floor(seconds / 3600) + "h";
    if (seconds < 604800) return Math.floor(seconds / 86400) + "d";

    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function friendlyError(error) {
    // api() already turns server problems into plain sentences
    return error && error.message ? error.message : "Something went wrong. Please try again.";
}


/* ------------------- hooks called from social.js ------------------ */

function onFeedOpened() {

    loadHome(true);
    refreshActivity();
    openLinkedPost();
}

function onFeedClosed() {

    posts = [];
    postStore.clear();
    feedState.comments = [];
    feedState.stories = [];
    feedState.notifs = [];
    feedState.unread = 0;
    feedState.error = null;
    feedState.hasMore = false;

    closeStoryViewer(true);
    discardComposer();
    closePostMenu();
    closeImageViewer(true);
    closeModal("editPostModal");
    closeModal("reportModal");
    closeModal("confirmModal");
    closeModal("savedPostsModal");
    closeModal("postViewModal");
    removeStoryImage();

    ["feedContainer", "commentsContainer"].forEach(id => {
        const n = document.getElementById(id);
        if (n) n.replaceChildren();
    });

        renderStories(true);
    closeModal("postModal");
    closeModal("commentModal");
    closeModal("storyModal");
}

// Switching tabs quickly does not refetch; pass true to force a refresh
function loadHome(force) {

    const fresh = feedState.loadedAt && Date.now() - feedState.loadedAt < 20000;

    if (!force && fresh && posts.length) return;

    loadFeed();
    loadStories(true);
}


/* ================================ FEED ============================ */

function storePost(p) {
    const merged = Object.assign(postStore.get(p.id) || {}, p);
    postStore.set(p.id, merged);
    return merged;
}

let feedRequest = null;

function feedSignature() {
    return JSON.stringify(posts.map(p => [
        p.id, p.like_count, p.comment_count, p.liked, p.saved, p.content, p.edited,
        p.author.avatar_url, p.author.full_name
    ]));
}

// One request at a time: repeated calls share the one already running
function loadFeed() {

    if (feedRequest) return feedRequest;

    feedRequest = (async () => {

        const before = feedSignature();

        feedState.loading = posts.length === 0;
        feedState.error = null;

        if (feedState.loading) renderPosts();

        try {
            const data = await api("/feed");

            posts = data.posts.map(storePost);
            feedState.hasMore = data.has_more;
            feedState.loadedAt = Date.now();

        } catch (error) {
            feedState.error = friendlyError(error);
        }

        feedState.loading = false;

        // skip the redraw when nothing changed, so scrolling is never disturbed
        if (feedState.error || feedSignature() !== before || !document.querySelector("#feedContainer .post-card")) {
            renderPosts();
        }

    })().finally(() => { feedRequest = null; });

    return feedRequest;
}

async function loadMorePosts() {

    if (feedState.loadingMore || !posts.length || !feedState.hasMore) return;

    feedState.loadingMore = true;
    setFooterLoading(true);

    let fresh = [];

    try {
        const data = await api("/feed?before_id=" + posts[posts.length - 1].id);

        fresh = data.posts.map(storePost);
        posts = posts.concat(fresh);
        feedState.hasMore = data.has_more;

    } catch (error) {
        showToast(friendlyError(error));
    }

    feedState.loadingMore = false;
    appendPosts(fresh);          // only the new cards are drawn
}

let feedObserver = null;

// "Load more" button; it also loads by itself when scrolled near
function feedFooter() {

    const footer = el("div", "feed-footer");

    if (feedState.hasMore) {
        const more = actionButton(
            feedState.loadingMore ? "Loading..." : "Load more posts",
            "ghost", loadMorePosts, null, feedState.loadingMore
        );
        more.classList.add("load-more-posts");
        footer.append(more);

        if (typeof IntersectionObserver !== "undefined") {

            if (!feedObserver) {
                feedObserver = new IntersectionObserver(entries => {
                    if (entries.some(e => e.isIntersecting)) loadMorePosts();
                }, { rootMargin: "600px" });
            }

            feedObserver.disconnect();
            feedObserver.observe(footer);
        }
    } else if (feedObserver) {
        feedObserver.disconnect();
    }

    return footer;
}

function setFooterLoading(loading) {

    const more = document.querySelector("#feedContainer .load-more-posts");

    if (more) {
        more.disabled = loading;
        more.lastChild.textContent = loading ? "Loading..." : "Load more posts";
    }
}

function appendPosts(list) {

    const box = document.getElementById("feedContainer");

    if (!box) return;

    box.querySelector(".feed-footer")?.remove();

    const frag = document.createDocumentFragment();
    list.forEach(p => frag.append(postCard(p)));
    box.append(frag, feedFooter());
}

function renderPosts() {

    const box = document.getElementById("feedContainer");

    if (!box) return;

    box.replaceChildren();

    if (feedState.loading) {
        box.append(skeletonRows(3));
        return;
    }

    if (feedState.error && posts.length === 0) {
        box.append(stateBlock("alert", "Couldn't load your feed",
            feedState.error, loadFeed));
        return;
    }

    if (posts.length === 0) {

        const empty = stateBlock("file", "No posts yet",
            "Add friends and start sharing with your community.");

        const row = el("div", "empty-actions");
        row.append(
            actionButton("Create a post", "primary", () => openPostModal()),
            actionButton("Find friends", "ghost", () => showScreen("friends"))
        );
        empty.append(row);

        box.append(empty);
        return;
    }

    const frag = document.createDocumentFragment();
    posts.forEach(p => frag.append(postCard(p)));
    box.append(frag, feedFooter());
}


/* ------------------------------ post card ------------------------- */

function heartSvg() {

    // heart with a ring of small dots used for the like burst
    const dots = [[0, -12], [10, -6], [10, 6], [0, 12], [-10, 6], [-10, -6]]
        .map(([x, y]) =>
            '<circle cx="12" cy="12" r="1.6" style="--dx:' + x + 'px;--dy:' + y + 'px"/>'
        ).join("");

    const t = document.createElement("template");
    t.innerHTML =
        '<svg class="heart" xmlns="http://www.w3.org/2000/svg" width="22" height="22" ' +
        'viewBox="0 0 24 24" aria-hidden="true">' +
        '<g class="burst">' + dots + "</g>" +
        '<g class="heart-shape" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        FEED_ICONS.heart + "</g></svg>";

    return t.content.firstChild;
}

function postMetaText(p) {
    return "@" + p.author.username + "  \u00b7  " + timeAgo(p.created_at) +
        (p.edited ? "  \u00b7  Edited" : "");
}

function postCard(p) {

    const card = el("article", "post-card");
    card.dataset.postId = p.id;

    // ---- header: picture, name, and the three-dot menu
    const head = el("div", "post-head");

    const avatar = avatarNode(p.author);
    avatar.classList.add("clickable");
    avatar.addEventListener("click", () => openUserProfile(p.author.username));

    const who = el("div", "post-who");
    const name = el("button", "post-name", p.author.full_name);
    name.type = "button";
    name.addEventListener("click", () => openUserProfile(p.author.username));
    who.append(name, el("small", null, postMetaText(p)));

    const menu = el("button", "post-menu-btn");
    menu.type = "button";
    menu.setAttribute("aria-label", "Post options");
    menu.setAttribute("aria-haspopup", "menu");
    menu.setAttribute("aria-expanded", "false");
    menu.append(feedIcon("dots", 20));
    menu.addEventListener("click", event => {
        event.stopPropagation();
        openPostMenu(p.id, menu);
    });

    head.append(avatar, who, menu);
    card.append(head);

    // ---- body
    if (p.content) card.append(el("p", "post-text", p.content));

    if (p.image_url) {
        const open = el("button", "post-image-link");
        open.type = "button";
        open.setAttribute("aria-label", "Open photo");

        const img = el("img", "post-image");
        img.alt = "Post photo";
        img.loading = "lazy";
        img.decoding = "async";
        img.addEventListener("load", () => img.classList.add("loaded"));
        img.addEventListener("error", () => {
            open.replaceWith(el("div", "post-image-missing", "This image is unavailable"));
        });
        img.src = API_URL + p.image_url;

        card.dataset.imageUrl = API_URL + p.image_url;

        // opens inside PlayHub: nothing navigates away, so the feed stays where it is
        open.addEventListener("click", () => openPostPhoto(card));
        open.append(img);
        card.append(open);
    }

    if (p.video_url) card.append(videoBlock(p));

    // ---- actions
    const actions = el("div", "post-actions");

    const like = el("button", "like-btn");
    like.type = "button";
    like.setAttribute("aria-label", "Like");
    like.append(heartSvg(), el("span", "like-count"));
    like.addEventListener("click", () => likePost(p.id));

    const comment = el("button", "comment-btn");
    comment.type = "button";
    comment.setAttribute("aria-label", "Comments");
    comment.append(feedIcon("comment", 22), el("span", "comment-count"));
    comment.addEventListener("click", () => openComments(p.id));

    actions.append(like, comment);
    card.append(actions);

    syncActions(card, p);

    return card;
}

function videoBlock(p) {

    const wrap = el("div", "post-video-wrap");

    const video = el("video", "post-video");
    video.controls = true;
    video.preload = "metadata";
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.setAttribute("aria-label", "Post video");

    video.addEventListener("loadedmetadata", () => wrap.classList.add("ready"));

    video.addEventListener("error", () => {
        wrap.replaceChildren(el("div", "post-image-missing", "This video is unavailable"));
    });

    // one video at a time
    video.addEventListener("play", () => {
        document.querySelectorAll("video.post-video").forEach(other => {
            if (other !== video) other.pause();
        });
    });

    // "#t=0.1" makes phones show the first picture instead of a black box
    video.src = API_URL + p.video_url + "#t=0.1";

    wrap.append(video);

    return wrap;
}


// Called from the confirmation dialog. Throws on failure so the dialog can show why.
async function deletePost(id) {

    await api("/posts/" + id, { method: "DELETE" });

    posts = posts.filter(p => p.id !== id);
    postStore.delete(id);

    document.querySelectorAll('.post-card[data-post-id="' + id + '"], .post-hidden[data-post-id="' + id + '"]')
        .forEach(n => n.remove());

    if (posts.length === 0) renderPosts();

    if (currentUser.posts_count) currentUser.posts_count--;
    updateProfile();

    showToast("Post deleted");
}

// Updates the like/comment buttons of every card showing this post
function syncActions(card, p) {

    const like = card.querySelector(".like-btn");

    like.classList.toggle("liked", p.liked);
    like.setAttribute("aria-pressed", String(p.liked));
    like.querySelector(".like-count").textContent = p.like_count;

    card.querySelector(".comment-count").textContent = p.comment_count;
}

function syncPostEverywhere(id, animate) {

    const p = postStore.get(id);

    document.querySelectorAll('.post-card[data-post-id="' + id + '"]').forEach(card => {

        syncActions(card, p);

        if (animate) {
            const btn = card.querySelector(".like-btn");
            btn.classList.remove("pop", "unpop");
            void btn.offsetWidth;                       // restart the animation
            btn.classList.add(animate);
            setTimeout(() => btn.classList.remove(animate), 650);
        }
    });
}


/* -------------------------------- likes --------------------------- */

async function likePost(id) {

    const p = postStore.get(id);

    if (!p || p.pending) return;

    p.pending = true;

    const wasLiked = p.liked;

    // update instantly, then confirm with the server
    p.liked = !wasLiked;
    p.like_count += wasLiked ? -1 : 1;
    syncPostEverywhere(id, wasLiked ? "unpop" : "pop");

    try {
        const result = await api("/posts/" + id + "/like", {
            method: wasLiked ? "DELETE" : "POST"
        });

        p.liked = result.liked;
        p.like_count = result.like_count;

    } catch (error) {
        p.liked = wasLiked;
        p.like_count += wasLiked ? 1 : -1;
        showToast("Couldn't update your like. Please try again.");
    }

    p.pending = false;
    syncPostEverywhere(id, null);
}


/* ============================ CREATE POST ========================== */







/* =============================== COMMENTS ========================== */

async function openComments(postId) {

    selectedPostId = postId;
    feedState.comments = [];
    feedState.commentsLoading = true;
    feedState.commentsError = null;

    renderComments();

    document.getElementById("commentModal").classList.remove("hidden");

    try {
        const data = await api("/posts/" + postId + "/comments");

        if (selectedPostId !== postId) return;

        feedState.comments = data.comments;
        setCommentCount(postId, data.comment_count);

    } catch (error) {
        if (selectedPostId !== postId) return;
        feedState.commentsError = friendlyError(error);
    }

    feedState.commentsLoading = false;
    renderComments();
}

function setCommentCount(postId, count) {

    const p = postStore.get(postId);

    if (p) {
        p.comment_count = count;
        syncPostEverywhere(postId, null);
    }
}

function renderComments() {

    const box = document.getElementById("commentsContainer");

    if (!box) return;

    box.replaceChildren();

    if (feedState.commentsLoading) {
        box.append(skeletonRows(2));
        return;
    }

    if (feedState.commentsError) {
        box.append(stateBlock("alert", "Couldn't load comments",
            feedState.commentsError, () => openComments(selectedPostId)));
        return;
    }

    if (feedState.comments.length === 0) {
        box.append(stateBlock("comment", "No comments yet",
            "Be the first person to comment."));
        return;
    }

    feedState.comments.forEach(c => {

        const item = el("div", "comment");

        const top = el("div", "comment-top");
        const name = el("button", "post-name", c.author.full_name);
        name.type = "button";
        name.addEventListener("click", () => {
            closeModal("commentModal");
            openUserProfile(c.author.username);
        });

                top.append(avatarNode(c.author), name, el("small", null, timeAgo(c.created_at)));

        if (c.mine) {
            const del = el("button", "comment-delete", "Delete");
            del.type = "button";
            del.addEventListener("click", () => deleteComment(c.id));
            top.append(del);
        }

        item.append(top, el("p", null, c.text));
        box.append(item);
    });
}

async function addComment() {

    const input = document.getElementById("commentInput");
    const text = input.value.trim();

    if (!text || !selectedPostId) return;

    const postId = selectedPostId;
    const button = input.parentElement.querySelector("button");

    button.disabled = true;

    try {
        const data = await api("/posts/" + postId + "/comments", {
            method: "POST",
            body: { text: text }
        });

        if (selectedPostId === postId) {
            feedState.comments.push(data.comment);
            renderComments();

            const box = document.getElementById("commentsContainer");
            box.scrollTop = box.scrollHeight;
        }

        input.value = "";
        setCommentCount(postId, data.comment_count);

    } catch (error) {
        showToast(friendlyError(error));
    }

    button.disabled = false;
}

async function deleteComment(id) {

    const postId = selectedPostId;

    try {
        const data = await api("/comments/" + id, { method: "DELETE" });

        feedState.comments = feedState.comments.filter(c => c.id !== id);
        renderComments();
        setCommentCount(postId, data.comment_count);

    } catch (error) {
        showToast(friendlyError(error));
    }
}


/* ============================ PROFILE POSTS ======================== */

function renderProfilePosts(profile) {

    const body = document.getElementById("userProfileBody");

    const section = el("div", "profile-posts");
    section.id = "profilePosts";
    section.append(el("div", "list-title", "Posts"), skeletonRows(1));
    body.append(section);

    loadProfilePosts(profile, section, null);
}

async function loadProfilePosts(profile, section, beforeId) {

    try {
        const data = await api(
            "/users/" + encodeURIComponent(profile.username) + "/posts" +
            (beforeId ? "?before_id=" + beforeId : "")
        );

        if (!section.isConnected) return;       // the profile was closed or redrawn

        if (!beforeId) section.replaceChildren(el("div", "list-title", "Posts"));
        else section.querySelector(".load-more-posts")?.remove();

        if (data.restricted) {
            section.append(stateBlock("lock", "Posts are for friends",
                "Become friends with " + profile.full_name + " to see what they share."));
            return;
        }

        if (data.posts.length === 0 && !beforeId) {
            section.append(stateBlock("file", "No posts yet",
                profile.relationship === "self"
                    ? "Things you share will show up here."
                    : profile.full_name + " hasn't posted anything yet."));
            return;
        }

        const list = el("div", "profile-post-list");
        const stored = data.posts.map(storePost);
        stored.forEach(p => list.append(postCard(p)));
        section.append(list);

        if (data.has_more) {
            const last = stored[stored.length - 1].id;
            const more = actionButton("Load more posts", "ghost",
                () => loadProfilePosts(profile, section, last));
            more.classList.add("load-more-posts");
            section.append(more);
        }

    } catch (error) {
        if (!section.isConnected) return;

        section.replaceChildren(el("div", "list-title", "Posts"),
            stateBlock("alert", "Couldn't load posts", friendlyError(error),
                () => loadProfilePosts(profile, section, beforeId)));
    }
}


/* ============================== NOTIFICATIONS ====================== */

async function refreshActivity() {

    try {
        const data = await api("/notifications");

        feedState.notifs = data.items;
        feedState.unread = data.unread;

    } catch (error) {
        return;
    }

    updateBadges();
    renderNotifications();

    loadStories(true);
}

function unreadActivityCount() {
    return feedState.unread;
}

// Adds like/comment activity to the existing bell list. Returns how many were added.
function appendActivityNotifications(list) {

    feedState.notifs.forEach(n => {

        const item = el("div", "notice-item" + (n.read ? "" : " unread"));
        item.append(avatarNode(n.actor));

        const text = el("div", "notice-text");
        const line = el("div");
        line.append(
            el("strong", null, n.actor.full_name),
            document.createTextNode(
                n.kind === "post_like" ? " liked your post" : " commented on your post"
            )
        );
        text.append(line, el("small", "notice-time", timeAgo(n.created_at)));
        item.append(text);

        item.addEventListener("click", () => {
            closeModal("notificationModal");
            showScreen("home");
            openComments(n.post_id);
        });

        list.append(item);
    });

    return feedState.notifs.length;
}

async function markActivityRead() {

    if (feedState.unread === 0) return;

    try {
        await api("/notifications/read", { method: "POST" });
        feedState.unread = 0;
        updateBadges();
    } catch (error) {
        // try again next time the bell is opened
    }
}


/* ================================ STORIES ========================== */

let storiesRequest = null;

function loadStories(silent) {

    if (storiesRequest) return storiesRequest;

    storiesRequest = (async () => {

        try {
            feedState.stories = await api("/stories");
            feedState.storiesError = null;
        } catch (error) {
            feedState.storiesError = friendlyError(error);
            if (!silent) showToast(feedState.storiesError);
        }

        renderStories();

    })().finally(() => { storiesRequest = null; });

    return storiesRequest;
}

let storiesSignature = null;

function renderStories(force) {

    const bar = document.getElementById("storiesBar");

    if (!bar) return;

    const signature = JSON.stringify(feedState.stories.map(g => [
        g.user.username, g.user.avatar_url, g.all_viewed, g.stories.map(s => s.id)
    ]));

    if (!force && signature === storiesSignature) return;     // nothing changed

    storiesSignature = signature;

    // keep the "add story" button, redraw the rest
    Array.from(bar.children).forEach(child => {
        if (!child.classList.contains("add-story")) child.remove();
    });

    feedState.stories.forEach((group, index) => {

        const btn = el("button", "story");
        btn.type = "button";
        btn.addEventListener("click", () => openStoryViewer(index));

        const ring = el("div", "story-ring " + (group.all_viewed ? "viewed" : "unviewed"));
        ring.append(avatarNode(group.user));

        btn.append(ring, el("span", null, group.is_me ? "Your story" : group.user.full_name.split(" ")[0]));
        bar.append(btn);
    });
}

/* ---- create a story ---- */

function createStory() {

    removeStoryImage();
    document.getElementById("storyCaption").value = "";
    document.getElementById("storyModal").classList.remove("hidden");
}

function previewStoryImage(event) {

    const file = event.target.files[0];

    if (!file) return;

    if (!checkImageFile(file)) {
        event.target.value = "";
        return;
    }

    removeStoryImage();

    storyFile = file;
    storyPreviewUrl = URL.createObjectURL(file);

    document.getElementById("storyPreviewImg").src = storyPreviewUrl;
    document.getElementById("storyPreview").classList.remove("hidden");
    document.getElementById("storyPicker").classList.add("hidden");
}

function removeStoryImage() {

    storyFile = null;

    if (storyPreviewUrl) {
        URL.revokeObjectURL(storyPreviewUrl);
        storyPreviewUrl = null;
    }

    const input = document.getElementById("storyImage");
    if (input) input.value = "";

    const preview = document.getElementById("storyPreview");
    if (preview) preview.classList.add("hidden");

    const picker = document.getElementById("storyPicker");
    if (picker) picker.classList.remove("hidden");
}

function cancelStory() {

    removeStoryImage();
    document.getElementById("storyCaption").value = "";
    closeModal("storyModal");
}

async function publishStory() {

    if (!storyFile) {
        showToast("Choose a photo for your story");
        return;
    }

    const button = document.getElementById("storyPublish");

    button.disabled = true;
    button.textContent = "Publishing...";

    try {
        const form = new FormData();
        form.append("image", storyFile);

        const caption = document.getElementById("storyCaption").value.trim();
        if (caption) form.append("caption", caption);

        await api("/stories", { method: "POST", formData: form });

        cancelStory();
        showToast("Story published");
        loadStories(true);

    } catch (error) {
        showToast(friendlyError(error));       // the photo stays selected
    }

    button.disabled = false;
    button.textContent = "Publish story";
}

/* ---- story viewer ---- */

const STORY_SECONDS = 5;

const viewer = {
    open: false,
    group: 0,
    index: 0,
    timer: null,
    remaining: 0,
    startedAt: 0,
    paused: false,
    heldPause: false,
    holdTimer: null,
    confirmDelete: false
};

function openStoryViewer(groupIndex) {

    if (!feedState.stories[groupIndex]) return;

    viewer.open = true;
    viewer.group = groupIndex;

    const stories = feedState.stories[groupIndex].stories;
    const firstNew = stories.findIndex(s => !s.viewed);
    viewer.index = firstNew === -1 ? 0 : firstNew;

    document.getElementById("storyViewer").classList.remove("hidden");
    document.addEventListener("keydown", storyKeys);

    showStory();
}

function closeStoryViewer(quiet) {

    clearTimeout(viewer.timer);
    clearTimeout(viewer.holdTimer);

    viewer.open = false;
    viewer.timer = null;

    document.removeEventListener("keydown", storyKeys);

    const node = document.getElementById("storyViewer");
    if (node) node.classList.add("hidden");

    const img = document.getElementById("storyViewerImage");
    if (img) img.removeAttribute("src");

    if (!quiet) loadStories(true);       // refresh the viewed / unviewed rings
}

function storyKeys(event) {

    if (event.key === "Escape") closeStoryViewer();
    if (event.key === "ArrowRight") nextStory();
    if (event.key === "ArrowLeft") prevStory();
}

function currentStory() {
    const group = feedState.stories[viewer.group];
    return group ? group.stories[viewer.index] : null;
}

function showStory() {

    clearTimeout(viewer.timer);

    const group = feedState.stories[viewer.group];
    const story = currentStory();

    if (!group || !story) {
        closeStoryViewer();
        return;
    }

    viewer.paused = false;
    viewer.confirmDelete = false;

    // progress bars
    const bars = document.getElementById("storyBars");
    bars.replaceChildren();

    group.stories.forEach((s, i) => {
        const bar = el("div", "story-bar");
        const fill = el("i");
        if (i < viewer.index) fill.style.width = "100%";
        bar.append(fill);
        bars.append(bar);
    });

    // header
    const who = document.getElementById("storyWho");
    who.replaceChildren(avatarNode(group.user),
        (() => {
            const box = el("div", "story-who-text");
            box.append(
                el("strong", null, group.is_me ? "Your story" : group.user.full_name),
                el("small", null, timeAgo(story.created_at))
            );
            return box;
        })());

    // footer: caption, and for your own story the view count + delete
    const caption = document.getElementById("storyCaptionText");
    caption.textContent = story.caption;
    caption.classList.toggle("hidden", !story.caption);

    const own = document.getElementById("storyOwn");
    own.replaceChildren();
    own.classList.toggle("hidden", !group.is_me);

    if (group.is_me) {
        const seen = el("span", "story-seen");
        seen.append(feedIcon("eye", 16),
            document.createTextNode(" " + (story.view_count || 0) +
                ((story.view_count || 0) === 1 ? " view" : " views")));

        const del = actionButton("Delete", "ghost", () => onStoryDelete(del, story));
        del.classList.add("story-delete");

        own.append(seen, del);
    }

    // the picture; the timer starts once it is on screen
    const stage = document.getElementById("storyStage");
    const img = document.getElementById("storyViewerImage");
    const error = document.getElementById("storyError");

    error.classList.add("hidden");
    img.classList.remove("hidden");
    img.onload = () => startStoryTimer();
    img.onerror = () => {
        img.classList.add("hidden");
        error.classList.remove("hidden");
    };
    img.src = API_URL + story.image_url;

    // tell the server it was seen (not for your own story)
    if (!group.is_me && !story.viewed) {
        story.viewed = true;
        api("/stories/" + story.id + "/view", { method: "POST" }).catch(() => {});
    }
}

function startStoryTimer() {

    const bars = document.querySelectorAll("#storyBars .story-bar i");
    const fill = bars[viewer.index];

    if (!fill) return;

    viewer.remaining = STORY_SECONDS * 1000;
    viewer.startedAt = Date.now();

    fill.style.animation = "none";
    void fill.offsetWidth;
    fill.style.animation = "story-fill " + STORY_SECONDS + "s linear forwards";

    clearTimeout(viewer.timer);
    viewer.timer = setTimeout(nextStory, viewer.remaining);
}

function pauseStory() {

    if (viewer.paused || !viewer.timer) return;

    viewer.paused = true;
    clearTimeout(viewer.timer);
    viewer.timer = null;
    viewer.remaining -= Date.now() - viewer.startedAt;

    const fill = document.querySelectorAll("#storyBars .story-bar i")[viewer.index];
    if (fill) fill.style.animationPlayState = "paused";
}

function resumeStory() {

    if (!viewer.paused) return;

    viewer.paused = false;
    viewer.startedAt = Date.now();
    viewer.timer = setTimeout(nextStory, Math.max(viewer.remaining, 0));

    const fill = document.querySelectorAll("#storyBars .story-bar i")[viewer.index];
    if (fill) fill.style.animationPlayState = "running";
}

function nextStory() {

    if (!viewer.open) return;

    const group = feedState.stories[viewer.group];

    if (viewer.index < group.stories.length - 1) {
        viewer.index++;
        showStory();
        return;
    }

    // finished this person: go to the next person, or close
    if (viewer.group < feedState.stories.length - 1) {
        viewer.group++;
        viewer.index = 0;
        showStory();
        return;
    }

    closeStoryViewer();
}

function prevStory() {

    if (!viewer.open) return;

    if (viewer.index > 0) {
        viewer.index--;
    } else if (viewer.group > 0) {
        viewer.group--;
        viewer.index = 0;
    }

    showStory();
}

// Tap left / right to move. Press and hold to pause.
function onStoryPress() {
    viewer.heldPause = false;
    clearTimeout(viewer.holdTimer);
    viewer.holdTimer = setTimeout(() => {
        viewer.heldPause = true;
        pauseStory();
    }, 220);
}

function onStoryRelease() {
    clearTimeout(viewer.holdTimer);
    if (viewer.heldPause) resumeStory();
}

function onStoryTap(direction) {

    if (viewer.heldPause) {          // that was a hold, not a tap
        viewer.heldPause = false;
        return;
    }

    if (direction === "next") nextStory();
    else prevStory();
}

function onStoryDelete(button, story) {

    if (!viewer.confirmDelete) {
        viewer.confirmDelete = true;
        pauseStory();
        button.lastChild.textContent = "Tap again to delete";
        return;
    }

    api("/stories/" + story.id, { method: "DELETE" })
        .then(() => {
            const group = feedState.stories[viewer.group];
            group.stories.splice(viewer.index, 1);

            if (group.stories.length === 0) {
                feedState.stories.splice(viewer.group, 1);
                closeStoryViewer();
                showToast("Story deleted");
                return;
            }

            viewer.index = Math.min(viewer.index, group.stories.length - 1);
            showToast("Story deleted");
            showStory();
        })
        .catch(error => showToast(friendlyError(error)));
}


/* -------------------- small things wired once --------------------- */

document.addEventListener("DOMContentLoaded", () => {

    const comment = document.getElementById("commentInput");

    if (comment) {
        comment.addEventListener("keydown", event => {
            if (event.key === "Enter") {
                event.preventDefault();
                addComment();
            }
        });
    }
});



/* =====================================================================
   POST COMPOSER: photo or video, previews, progress, no double posting
   ===================================================================== */

const byId = id => document.getElementById(id);

const POST_MAX_CHARS = 2000;
const VIDEO_MAX_MB = 50;
const VIDEO_TYPES = ["video/mp4", "video/webm", "video/quicktime"];
const VIDEO_EXTENSION = /\.(mp4|webm|mov)$/i;

const composer = { media: null, token: null, upload: null, uploading: false };

function newPostToken() {

    if (window.crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, "");

    return Date.now().toString(36) + Math.random().toString(36).slice(2, 14);
}

function sizeText(bytes) {
    return (bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0) + " MB";
}

function imageProblem(file) {

    if (!FEED_IMAGE_TYPES.includes(file.type)) {
        return "Only JPG, PNG, GIF or WebP photos are allowed";
    }

    if (file.size > FEED_MAX_MB * 1048576) {
        return "That photo is too large (" + sizeText(file.size) + "). The limit is " + FEED_MAX_MB + " MB.";
    }

    return null;
}

function videoProblem(file) {

    if (!VIDEO_TYPES.includes(file.type) && !VIDEO_EXTENSION.test(file.name || "")) {
        return "Only MP4, WebM or MOV videos are allowed";
    }

    if (file.size > VIDEO_MAX_MB * 1048576) {
        return "That video is too large (" + sizeText(file.size) + "). The limit is " + VIDEO_MAX_MB + " MB.";
    }

    if (file.size === 0) return "That video file is empty";

    return null;
}

function openPostModal(mode) {

    composer.token = composer.token || newPostToken();

    byId("postModal").classList.remove("hidden");

    setMsg("postMsg", "");
    updateComposer();

    if (mode === true) byId("postImage").click();
    else if (mode === "video") byId("postVideo").click();
    else byId("postText").focus();
}

function closePostModal() {

    if (composer.uploading) {
        showToast("Your post is still uploading. Use Cancel upload to stop it.");
        return;
    }

    closeModal("postModal");
}

function postInput() {
    updateComposer();
}

function updateComposer() {

    const box = byId("postText");

    if (!box) return;

    const length = box.value.length;
    const counter = byId("postCount");

    counter.textContent = length + "/" + POST_MAX_CHARS;
    counter.classList.toggle("over", length > POST_MAX_CHARS);

    const hasContent = box.value.trim().length > 0 || !!composer.media;

    byId("postSubmit").disabled = feedState.posting || !hasContent || length > POST_MAX_CHARS;
}

function setComposerMedia(kind, file) {

    clearComposerMedia(true);

    const url = URL.createObjectURL(file);

    composer.media = { kind: kind, file: file, url: url };

    if (kind === "image") {
        selectedImage = file;
        byId("previewImage").src = url;
        byId("imagePreview").classList.remove("hidden");
    } else {
        byId("previewVideo").src = url;
        byId("videoInfo").textContent = file.name + "  \u00b7  " + sizeText(file.size);
        byId("videoPreview").classList.remove("hidden");
    }

    updateComposer();
}

function clearComposerMedia(silent) {

    if (composer.media) URL.revokeObjectURL(composer.media.url);

    composer.media = null;
    selectedImage = null;

    ["imagePreview", "videoPreview"].forEach(id => byId(id).classList.add("hidden"));

    const photo = byId("previewImage");
    photo.removeAttribute("src");

    const video = byId("previewVideo");
    video.pause();
    video.removeAttribute("src");
    video.load && video.load();

    byId("postImage").value = "";
    byId("postVideo").value = "";

    if (!silent) updateComposer();
}

function previewPostImage(event) {

    const file = event.target.files[0];

    if (!file) return;

    const problem = imageProblem(file);

    if (problem) {
        event.target.value = "";
        setMsg("postMsg", problem, "error");
        showToast(problem);
        return;
    }

    const replaced = composer.media && composer.media.kind === "video";

    setComposerMedia("image", file);

    setMsg("postMsg", replaced
        ? "Your video was replaced by this photo. A post can have a photo or a video."
        : "", "info");
}

function previewPostVideo(event) {

    const file = event.target.files[0];

    if (!file) return;

    const problem = videoProblem(file);

    if (problem) {
        event.target.value = "";
        setMsg("postMsg", problem, "error");
        showToast(problem);
        return;
    }

    const replaced = composer.media && composer.media.kind === "image";

    setComposerMedia("video", file);

    setMsg("postMsg", replaced
        ? "Your photo was replaced by this video. A post can have a photo or a video."
        : "", "info");
}

function removeSelectedImage() {
    clearComposerMedia();
    setMsg("postMsg", "");
}

function removeSelectedVideo() {
    clearComposerMedia();
    setMsg("postMsg", "");
}

// Throws away the draft completely (new token too)
function discardComposer() {

    if (composer.upload) composer.upload.abort();

    composer.uploading = false;
    composer.upload = null;
    composer.token = null;

    const box = byId("postText");
    if (box) box.value = "";

    clearComposerMedia(true);
    hideUploadProgress();
    setComposerBusy(false);
    setMsg("postMsg", "");
    updateComposer();
}

function cancelPost() {

    if (composer.uploading) {
        cancelUpload();
        return;
    }

    discardComposer();
    closeModal("postModal");
}

function cancelUpload() {

    if (composer.upload) composer.upload.abort();
}

function showUploadProgress(fraction) {

    const box = byId("postProgress");
    const percent = Math.round(Math.min(1, fraction) * 100);

    box.classList.remove("hidden");
    box.setAttribute("aria-valuenow", String(percent));

    byId("postProgressBar").style.width = percent + "%";
    byId("postProgressText").textContent =
        fraction >= 1 ? "Upload finished. Publishing your post..." : "Uploading " + percent + "%";
}

function hideUploadProgress() {

    const box = byId("postProgress");

    if (box) box.classList.add("hidden");
}

function setComposerBusy(busy) {

    ["postText", "postImage", "postVideo"].forEach(id => { byId(id).disabled = busy; });

    byId("postModal").classList.toggle("busy", busy);

    byId("postCancel").textContent = busy && composer.uploading ? "Cancel upload" : "Cancel";
}

// fetch() cannot report upload progress, so media posts use XMLHttpRequest
function uploadWithProgress(path, formData, onProgress) {

    const xhr = new XMLHttpRequest();

    const promise = new Promise((resolve, reject) => {

        xhr.open("POST", API_URL + path);

        const token = localStorage.getItem(TOKEN_KEY);
        if (token) xhr.setRequestHeader("Authorization", "Bearer " + token);

        xhr.upload.onprogress = event => {
            if (event.lengthComputable) onProgress(event.loaded / event.total);
        };

        xhr.onload = () => {

            let data = {};

            try { data = JSON.parse(xhr.responseText); } catch (error) { /* not JSON */ }

            if (xhr.status === 401) {
                showToast("Session expired. Please log in again.");
                logout();
                const expired = new Error("Session expired");
                expired.status = 401;
                reject(expired);
                return;
            }

            if (xhr.status >= 200 && xhr.status < 300) {
                resolve(data);
                return;
            }

            const failure = new Error(data.message || "Something went wrong. Please try again.");
            failure.status = xhr.status;
            failure.data = data;
            reject(failure);
        };

        xhr.onerror = () => {
            reject(new Error("Can't reach the PLAYHUB server. Check your connection and try again."));
        };

        xhr.onabort = () => {
            const cancelled = new Error("Upload cancelled");
            cancelled.aborted = true;
            reject(cancelled);
        };

        xhr.send(formData);
    });

    return { promise: promise, abort: () => xhr.abort() };
}

async function createPost() {

    if (feedState.posting) return;

    const text = byId("postText").value.trim();
    const media = composer.media;

    if (!text && !media) {
        setMsg("postMsg", "Write something or add a photo or video", "error");
        return;
    }

    if (text.length > POST_MAX_CHARS) {
        setMsg("postMsg", "Posts can be up to " + POST_MAX_CHARS + " characters", "error");
        return;
    }

    // one token per post: if this request is ever repeated, the server returns the same post
    composer.token = composer.token || newPostToken();

    const button = byId("postSubmit");
    const label = button.textContent;

    feedState.posting = true;
    button.disabled = true;
    button.textContent = "Posting...";
    setMsg("postMsg", "");

    let published = null;

    try {

        let post;

        if (media) {
            const form = new FormData();
            form.append(media.kind === "video" ? "video" : "image", media.file);
            if (text) form.append("text", text);
            form.append("client_token", composer.token);

            composer.uploading = true;
            setComposerBusy(true);
            showUploadProgress(0);

            composer.upload = uploadWithProgress("/posts", form, showUploadProgress);
            post = await composer.upload.promise;
        } else {
            setComposerBusy(true);
            post = await api("/posts", { method: "POST", body: { text: text, client_token: composer.token } });
        }

        published = post;

    } catch (error) {

        if (error.aborted) {
            setMsg("postMsg", "Upload cancelled. Your post is still here if you want to try again.", "info");
        } else {
            setMsg("postMsg", friendlyError(error), "error");
            showToast(friendlyError(error));          // the draft stays so nothing is lost
        }
    }

    composer.uploading = false;
    composer.upload = null;
    feedState.posting = false;

    button.textContent = label;
    hideUploadProgress();
    setComposerBusy(false);

    if (published) {

        // A repeated request returns the very same post (same id AND same time).
        // The same id with another time is a stale leftover (ids can be reused
        // after a delete), so that old entry is dropped instead.
        const existing = posts.find(p => p.id === published.id);
        const already = !!existing && existing.created_at === published.created_at;

        if (existing && !already) {
            posts = posts.filter(p => p.id !== published.id);
            document.querySelectorAll('.post-card[data-post-id="' + published.id + '"]')
                .forEach(node => node.remove());
        }

        if (!already) {
            posts.unshift(storePost(published));

            currentUser.posts_count = (currentUser.posts_count || 0) + 1;
            updateProfile();

            if (posts.length === 1) {
                renderPosts();
            } else {
                const card = postCard(posts[0]);
                card.classList.add("enter");
                byId("feedContainer").prepend(card);
            }
        }

        discardComposer();
        closeModal("postModal");
        showToast("Post published");
    }

    updateComposer();
}


/* =====================================================================
   THREE-DOT POST MENU AND ITS ACTIONS
   ===================================================================== */

const menuState = { button: null };

function postMenuItems(p) {

    const items = [];

    if (p.mine) items.push({ label: "Edit post", icon: "pencil", run: openEditPost });

    items.push({ label: p.saved ? "Unsave post" : "Save post", icon: "bookmark", run: toggleSavePost });
    items.push({ label: "Copy post link", icon: "link", run: copyPostLink });

    if (!p.mine) {
        items.push({ label: "Hide post", icon: "eyeOff", run: hidePost });
        items.push({ label: "Report post", icon: "flag", run: openReport });
    }

    if (p.mine) {
        items.push({ separator: true });
        items.push({ label: "Delete post", icon: "trash", danger: true, run: confirmDeletePost });
    }

    return items;
}

function openPostMenu(id, button) {

    closePostMenu();

    const p = postStore.get(id);

    if (!p) return;

    const layer = byId("postMenuLayer");
    const menu = byId("postMenu");

    menu.replaceChildren();

    postMenuItems(p).forEach(item => {

        if (item.separator) {
            menu.append(el("div", "menu-sep"));
            return;
        }

        const row = el("button", "menu-item" + (item.danger ? " danger" : ""));
        row.type = "button";
        row.setAttribute("role", "menuitem");
        row.append(feedIcon(item.icon, 18), document.createTextNode(item.label));
        row.addEventListener("click", () => {
            closePostMenu(true);
            item.run(postStore.get(id) || p);
        });

        menu.append(row);
    });

    const sheet = window.innerWidth <= 650;

    layer.classList.toggle("sheet", sheet);
    layer.classList.remove("hidden");

    if (!sheet) {
        const rect = button.getBoundingClientRect();
        const width = 232;

        menu.style.left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)) + "px";
        menu.style.top = (rect.bottom + 6) + "px";

        const height = menu.offsetHeight || 0;

        if (height && rect.bottom + 6 + height > window.innerHeight - 8) {
            menu.style.top = Math.max(8, rect.top - height - 6) + "px";
        }
    } else {
        menu.style.left = menu.style.top = "";
    }

    button.setAttribute("aria-expanded", "true");
    menuState.button = button;

    document.addEventListener("keydown", postMenuKeys);
    window.addEventListener("resize", closePostMenu);
    if (!sheet) window.addEventListener("scroll", closePostMenu, true);

    const first = menu.querySelector("button");
    if (first) first.focus();
}

function closePostMenu(skipFocus) {

    const layer = byId("postMenuLayer");

    if (!layer || layer.classList.contains("hidden")) return;

    layer.classList.add("hidden");

    document.removeEventListener("keydown", postMenuKeys);
    window.removeEventListener("resize", closePostMenu);
    window.removeEventListener("scroll", closePostMenu, true);

    const button = menuState.button;
    menuState.button = null;

    if (button) {
        button.setAttribute("aria-expanded", "false");
        if (skipFocus !== true && button.isConnected) button.focus();
    }
}

function postMenuKeys(event) {

    const items = Array.from(byId("postMenu").querySelectorAll("button"));
    const at = items.indexOf(document.activeElement);

    if (event.key === "Escape") { closePostMenu(); event.preventDefault(); }
    if (event.key === "ArrowDown") { items[(at + 1) % items.length].focus(); event.preventDefault(); }
    if (event.key === "ArrowUp") { items[(at - 1 + items.length) % items.length].focus(); event.preventDefault(); }
    if (event.key === "Tab") closePostMenu(true);
}

/* ---- a reusable "Are you sure?" dialog ---- */

function showConfirm(options) {

    byId("confirmTitle").textContent = options.title;
    byId("confirmText").textContent = options.text;
    setMsg("confirmMsg", "");

    const ok = byId("confirmOk");

    ok.textContent = options.confirm;
    ok.className = "pbtn " + (options.danger ? "danger" : "primary");
    ok.disabled = false;
    byId("confirmCancel").disabled = false;

    ok.onclick = async () => {

        ok.disabled = true;
        byId("confirmCancel").disabled = true;
        ok.textContent = options.busy || "Working...";

        try {
            await options.onConfirm();
            closeModal("confirmModal");
        } catch (error) {
            setMsg("confirmMsg", friendlyError(error), "error");
            ok.disabled = false;
            byId("confirmCancel").disabled = false;
            ok.textContent = options.confirm;
        }
    };

    byId("confirmModal").classList.remove("hidden");
    byId("confirmCancel").focus();
}

function confirmDeletePost(p) {

    showConfirm({
        title: "Delete this post?",
        text: "This permanently deletes the post with its likes, comments and any photo or video. This can't be undone.",
        confirm: "Delete",
        busy: "Deleting...",
        danger: true,
        onConfirm: () => deletePost(p.id)
    });
}

/* ---- edit ---- */

let editingPostId = null;

function openEditPost(p) {

    editingPostId = p.id;

    byId("editPostText").value = p.content || "";
    setMsg("editPostMsg", "");
    updateEditCount();

    byId("editPostModal").classList.remove("hidden");
    byId("editPostText").focus();
}

function updateEditCount() {

    const n = byId("editPostText").value.length;
    const counter = byId("editPostCount");

    counter.textContent = n + "/" + POST_MAX_CHARS;
    counter.classList.toggle("over", n > POST_MAX_CHARS);
}

function closeEditPost() {
    editingPostId = null;
    closeModal("editPostModal");
}

function syncPostText(id) {

    const p = postStore.get(id);

    document.querySelectorAll('.post-card[data-post-id="' + id + '"]').forEach(card => {

        let text = card.querySelector(".post-text");

        if (p.content) {
            if (!text) {
                text = el("p", "post-text");
                card.querySelector(".post-head").after(text);
            }
            text.textContent = p.content;
        } else if (text) {
            text.remove();
        }

        card.querySelector(".post-who small").textContent = postMetaText(p);
    });
}

async function saveEditedPost() {

    const id = editingPostId;
    const p = postStore.get(id);

    if (!p) return;

    const text = byId("editPostText").value.trim();

    if (!text && !p.image_url && !p.video_url) {
        setMsg("editPostMsg", "A post needs some text, a photo or a video", "error");
        return;
    }

    if (text.length > POST_MAX_CHARS) {
        setMsg("editPostMsg", "Posts can be up to " + POST_MAX_CHARS + " characters", "error");
        return;
    }

    const button = byId("editPostSave");
    setBusy(button, true, "Saving...");

    try {
        const saved = await api("/posts/" + id, { method: "PUT", body: { text: text } });

        Object.assign(p, saved);
        syncPostText(id);

        closeEditPost();
        showToast("Post updated");

    } catch (error) {
        setMsg("editPostMsg", friendlyError(error), "error");
    }

    setBusy(button, false);
}

/* ---- save, copy link, hide, report ---- */

async function toggleSavePost(p) {

    const wasSaved = p.saved;

    try {
        await api("/posts/" + p.id + "/save", { method: wasSaved ? "DELETE" : "POST" });

        p.saved = !wasSaved;
        showToast(wasSaved ? "Removed from saved posts" : "Post saved");

        // unsaving inside the Saved posts list takes the card out of it
        if (wasSaved) {
            const list = byId("savedPostsList");
            const card = list && list.querySelector('.post-card[data-post-id="' + p.id + '"]');

            if (card) {
                card.remove();
                if (!list.querySelector(".post-card")) renderSavedEmpty();
            }
        }

    } catch (error) {
        showToast(friendlyError(error));
    }
}

function postLink(id) {
    return location.origin + location.pathname + "?post=" + id;
}

async function copyPostLink(p) {

    const link = postLink(p.id);

    try {
        await navigator.clipboard.writeText(link);
        showToast("Link copied");
        return;
    } catch (error) {
        // fall through to the older way
    }

    try {
        const box = document.createElement("textarea");
        box.value = link;
        box.style.position = "fixed";
        box.style.opacity = "0";
        document.body.append(box);
        box.select();
        const copied = document.execCommand("copy");
        box.remove();

        if (copied) {
            showToast("Link copied");
            return;
        }
    } catch (error) {
        // nothing else to try
    }

    showToast("Couldn't copy. The link is: " + link);
}

function collapsePost(p, message, allowUndo) {

    document.querySelectorAll('.post-card[data-post-id="' + p.id + '"]').forEach(card => {

        const note = el("div", "post-hidden");
        note.dataset.postId = p.id;
        note.append(el("span", null, message));

        if (allowUndo) {
            note.append(actionButton("Undo", "ghost", async () => {
                try {
                    await api("/posts/" + p.id + "/hide", { method: "DELETE" });
                    note.replaceWith(postCard(p));
                } catch (error) {
                    showToast(friendlyError(error));
                }
            }));
        }

        card.replaceWith(note);
    });
}

async function hidePost(p) {

    try {
        await api("/posts/" + p.id + "/hide", { method: "POST" });
        collapsePost(p, "Post hidden. You won't see it in your feed.", true);
    } catch (error) {
        showToast(friendlyError(error));
    }
}

let reportingPostId = null;

function openReport(p) {

    reportingPostId = p.id;

    document.querySelectorAll('input[name="reportReason"]').forEach(r => { r.checked = false; });
    byId("reportDetails").value = "";
    setMsg("reportMsg", "");

    byId("reportModal").classList.remove("hidden");
}

async function submitReport() {

    const chosen = document.querySelector('input[name="reportReason"]:checked');

    if (!chosen) {
        setMsg("reportMsg", "Please choose a reason", "error");
        return;
    }

    const p = postStore.get(reportingPostId);
    const button = byId("reportSubmit");

    setBusy(button, true, "Sending...");

    try {
        const result = await api("/posts/" + reportingPostId + "/report", {
            method: "POST",
            body: { reason: chosen.value, details: byId("reportDetails").value.trim() }
        });

        closeModal("reportModal");
        showToast(result.message);

        if (p) collapsePost(p, "Thanks for reporting. We'll review this post.", false);

    } catch (error) {
        setMsg("reportMsg", friendlyError(error), "error");
    }

    setBusy(button, false);
}


/* =====================================================================
   SAVED POSTS AND SHARED POST LINKS
   ===================================================================== */

const saved = { posts: [], hasMore: false, loading: false };

async function openSavedPosts() {

    byId("savedPostsModal").classList.remove("hidden");

    saved.posts = [];
    saved.hasMore = false;

    await loadSavedPosts(false);
}

function renderSavedEmpty() {

    byId("savedPostsList").replaceChildren(
        stateBlock("bookmark", "No saved posts yet",
            "Open the three-dot menu on a post and choose Save post to keep it here."));
}

async function loadSavedPosts(more) {

    if (saved.loading) return;

    saved.loading = true;

    const list = byId("savedPostsList");

    if (!more) list.replaceChildren(skeletonRows(2));

    try {
        const last = saved.posts.length ? saved.posts[saved.posts.length - 1].id : null;
        const data = await api("/posts/saved" + (more && last ? "?before_id=" + last : ""));

        const fresh = data.posts.map(storePost);
        saved.posts = more ? saved.posts.concat(fresh) : fresh;
        saved.hasMore = data.has_more;

        list.querySelector(".load-more-posts")?.remove();

        if (!more) list.replaceChildren();

        if (saved.posts.length === 0) {
            renderSavedEmpty();
        } else {
            fresh.forEach(p => list.append(postCard(p)));

            if (saved.hasMore) {
                const button = actionButton("Load more", "ghost", () => loadSavedPosts(true));
                button.classList.add("load-more-posts");
                list.append(button);
            }
        }

    } catch (error) {
        list.replaceChildren(stateBlock("alert", "Couldn't load your saved posts",
            friendlyError(error), () => loadSavedPosts(false)));
    }

    saved.loading = false;
}

// Someone opened PlayHub with a copied post link (?post=123)
feedState.linkedPost = null;

(function readPostLink() {

    const id = Number(new URLSearchParams(location.search).get("post"));

    if (!id) return;

    feedState.linkedPost = id;

    // clean the address bar so a refresh doesn't open it again
    try { history.replaceState(null, "", location.pathname + location.hash); } catch (error) { /* ignore */ }
})();

async function openLinkedPost() {

    const id = feedState.linkedPost;

    if (!id) return;

    feedState.linkedPost = null;

    const body = byId("postViewBody");

    body.replaceChildren(skeletonRows(1));
    byId("postViewModal").classList.remove("hidden");

    try {
        const post = await api("/posts/" + id);

        body.replaceChildren(postCard(storePost(post)));

    } catch (error) {
        body.replaceChildren(stateBlock("alert", "This post isn't available",
            "It may have been deleted, or it's only shared with the author's friends."));
    }
}


/* =====================================================================
   IN-APP PHOTO VIEWER (nothing opens in a new tab)
   ===================================================================== */

const imgViewer = { items: [], index: 0, open: false, pushed: false, zoomed: false, opener: null, touchX: 0 };

function openPostPhoto(card) {

    const group = card.closest("#feedContainer, #userProfileBody, #savedPostsList, #postViewBody")
        || card.parentElement;

    const cards = Array.from(group.querySelectorAll(".post-card[data-image-url]"));

    const items = cards.map(c => {
        const p = postStore.get(Number(c.dataset.postId));
        return {
            url: c.dataset.imageUrl,
            caption: p ? p.author.full_name + (p.content ? ": " + p.content : "") : ""
        };
    });

    openImageViewer(items, Math.max(0, cards.indexOf(card)));
}

function openImageViewer(items, index) {

    if (!items || !items.length) return;

    imgViewer.items = items;
    imgViewer.index = Math.max(0, Math.min(index || 0, items.length - 1));
    imgViewer.zoomed = false;
    imgViewer.opener = document.activeElement;

    const wasOpen = imgViewer.open;
    imgViewer.open = true;

    byId("imageViewer").classList.remove("hidden");
    document.body.classList.add("no-scroll");

    // the browser's Back button closes the viewer instead of leaving PlayHub
    if (!wasOpen) {
        try {
            history.pushState({ playhubViewer: true }, "");
            imgViewer.pushed = true;
        } catch (error) {
            imgViewer.pushed = false;
        }

        document.addEventListener("keydown", viewerKeys);
    }

    renderImageViewer();
    byId("ivClose").focus();
}

function renderImageViewer() {

    const item = imgViewer.items[imgViewer.index];
    const many = imgViewer.items.length > 1;

    const img = byId("ivImage");
    const stage = byId("ivStage");

    stage.classList.remove("zoomed");
    stage.classList.add("loading");
    imgViewer.zoomed = false;

    img.onload = () => stage.classList.remove("loading");
    img.onerror = () => stage.classList.remove("loading");
    img.src = item.url;
    img.alt = item.caption || "Photo";

    byId("ivCaption").textContent = item.caption || "";
    byId("ivCount").textContent = many ? (imgViewer.index + 1) + " / " + imgViewer.items.length : "";

    byId("ivPrev").classList.toggle("hidden", !many);
    byId("ivNext").classList.toggle("hidden", !many);

    byId("ivZoom").replaceChildren(feedIcon("zoomIn", 20));
    byId("ivZoom").setAttribute("aria-label", "Zoom in");
}

function viewerStep(direction) {

    const n = imgViewer.items.length;

    if (n < 2) return;

    imgViewer.index = (imgViewer.index + direction + n) % n;
    renderImageViewer();
}

function viewerToggleZoom() {

    imgViewer.zoomed = !imgViewer.zoomed;

    byId("ivStage").classList.toggle("zoomed", imgViewer.zoomed);

    const zoom = byId("ivZoom");
    zoom.replaceChildren(feedIcon(imgViewer.zoomed ? "zoomOut" : "zoomIn", 20));
    zoom.setAttribute("aria-label", imgViewer.zoomed ? "Zoom out" : "Zoom in");
}

function viewerKeys(event) {

    if (event.key === "Escape") closeImageViewer();
    if (event.key === "ArrowLeft") viewerStep(-1);
    if (event.key === "ArrowRight") viewerStep(1);
}

function finishCloseViewer() {

    imgViewer.open = false;
    imgViewer.pushed = false;

    byId("imageViewer").classList.add("hidden");
    byId("ivImage").removeAttribute("src");

    document.body.classList.remove("no-scroll");
    document.removeEventListener("keydown", viewerKeys);

    const opener = imgViewer.opener;
    imgViewer.opener = null;

    if (opener && opener.isConnected && opener.focus) opener.focus({ preventScroll: true });
}

function closeImageViewer(immediately) {

    if (!imgViewer.open) return;

    // Go back one history step; popstate (below) then finishes closing it.
    if (imgViewer.pushed && immediately !== true) {
        history.back();
        return;
    }

    finishCloseViewer();
}

window.addEventListener("popstate", () => {
    if (imgViewer.open) finishCloseViewer();
});

function viewerTouchStart(event) {
    imgViewer.touchX = event.changedTouches[0].clientX;
}

function viewerTouchEnd(event) {

    const dx = event.changedTouches[0].clientX - imgViewer.touchX;

    if (!imgViewer.zoomed && Math.abs(dx) > 60) viewerStep(dx < 0 ? 1 : -1);
}


/* ---- small things wired once ---- */

document.addEventListener("DOMContentLoaded", () => {

    const layer = byId("postMenuLayer");

    if (layer) {
        layer.addEventListener("click", event => {
            if (event.target === layer) closePostMenu();
        });
    }

    const text = byId("postText");

    if (text) {
        text.addEventListener("keydown", event => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                createPost();
            }
        });
    }

    const stage = byId("ivStage");

    if (stage) {
        stage.addEventListener("touchstart", viewerTouchStart, { passive: true });
        stage.addEventListener("touchend", viewerTouchEnd, { passive: true });

        // clicking the dark area around the photo closes the viewer
        stage.addEventListener("click", event => {
            if (event.target === stage) closeImageViewer();
        });
    }
});