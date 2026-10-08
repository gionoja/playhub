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
    removeSelectedImage();
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
        p.id, p.like_count, p.comment_count, p.liked, p.author.avatar_url, p.author.full_name
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

function postCard(p) {

    const card = el("article", "post-card");
    card.dataset.postId = p.id;

    // ---- header
    const head = el("div", "post-head");

    const avatar = avatarNode(p.author);
    avatar.classList.add("clickable");
    avatar.addEventListener("click", () => openUserProfile(p.author.username));

    const who = el("div", "post-who");
    const name = el("button", "post-name", p.author.full_name);
    name.type = "button";
    name.addEventListener("click", () => openUserProfile(p.author.username));
    who.append(name, el("small", null, "@" + p.author.username + "  \u00b7  " + timeAgo(p.created_at)));

    head.append(avatar, who);

    if (p.mine) head.append(deleteControl(p));

    card.append(head);

    // ---- body
    if (p.content) card.append(el("p", "post-text", p.content));

    if (p.image_url) {
        const link = el("a", "post-image-link");
        link.href = API_URL + p.image_url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";

                const img = el("img", "post-image");
        img.alt = "Post image";
        img.loading = "lazy";
        img.decoding = "async";
        img.addEventListener("load", () => img.classList.add("loaded"));
        img.addEventListener("error", () => {
            link.replaceWith(el("div", "post-image-missing", "This image is unavailable"));
        });
        img.src = API_URL + p.image_url;
        link.append(img);
        card.append(link);
    }

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

function deleteControl(p) {

    const wrap = el("div", "post-delete");

    const trash = el("button", "chat-icon-btn");
    trash.type = "button";
    trash.setAttribute("aria-label", "Delete post");
    trash.append(feedIcon("trash", 18));

    trash.addEventListener("click", () => {

        wrap.replaceChildren(
            el("small", null, "Delete?"),
            actionButton("Yes", "danger", () => deletePost(p.id)),
            actionButton("No", "ghost", () => wrap.replaceWith(deleteControl(p)))
        );
    });

    wrap.append(trash);

    return wrap;
}

async function deletePost(id) {

    try {
        await api("/posts/" + id, { method: "DELETE" });

        posts = posts.filter(p => p.id !== id);
        postStore.delete(id);

                document.querySelectorAll('.post-card[data-post-id="' + id + '"]')
            .forEach(n => n.remove());

        if (posts.length === 0) renderPosts();

        if (currentUser.posts_count) currentUser.posts_count--;
        updateProfile();

        showToast("Post deleted");

    } catch (error) {
        showToast(friendlyError(error));
    }
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

function openPostModal(withPhoto = false) {

    document.getElementById("postModal").classList.remove("hidden");

    if (withPhoto) {
        document.getElementById("postImage").click();
    }
}

function previewPostImage(event) {

    const file = event.target.files[0];

    if (!file) return;

    if (!checkImageFile(file)) {
        event.target.value = "";
        return;
    }

    removeSelectedImage();

    selectedImage = file;
    feedPreviewUrl = URL.createObjectURL(file);

    document.getElementById("previewImage").src = feedPreviewUrl;
    document.getElementById("imagePreview").classList.remove("hidden");
}

function removeSelectedImage() {

    selectedImage = null;

    if (feedPreviewUrl) {
        URL.revokeObjectURL(feedPreviewUrl);
        feedPreviewUrl = null;
    }

    const input = document.getElementById("postImage");
    if (input) input.value = "";

    const preview = document.getElementById("imagePreview");
    if (preview) preview.classList.add("hidden");

    const img = document.getElementById("previewImage");
    if (img) img.removeAttribute("src");
}

function cancelPost() {

    document.getElementById("postText").value = "";
    removeSelectedImage();
    closeModal("postModal");
}

async function createPost() {

    if (feedState.posting) return;

    const text = document.getElementById("postText").value.trim();

    if (!text && !selectedImage) {
        showToast("Write something or add a photo");
        return;
    }

    const button = document.querySelector("#postModal .primary-btn");
    const label = button.innerHTML;

    feedState.posting = true;
    button.disabled = true;
    button.textContent = "Posting...";

    try {

        let options;

        if (selectedImage) {
            const form = new FormData();
            form.append("image", selectedImage);
            if (text) form.append("text", text);
            options = { method: "POST", formData: form };
        } else {
            options = { method: "POST", body: { text: text } };
        }

        const post = await api("/posts", options);

                posts.unshift(storePost(post));

        currentUser.posts_count = (currentUser.posts_count || 0) + 1;
        updateProfile();


        document.getElementById("postText").value = "";
        removeSelectedImage();
        closeModal("postModal");

                if (posts.length === 1) {
            renderPosts();
        } else {
            const card = postCard(posts[0]);
            card.classList.add("enter");
            document.getElementById("feedContainer").prepend(card);
        }

        showToast("Post published");

    } catch (error) {
        showToast(friendlyError(error));       // the draft stays so nothing is lost
    }

    feedState.posting = false;
    button.disabled = false;
    button.innerHTML = label;
}


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