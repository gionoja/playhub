/* =====================================================================
   PLAYHUB profile: profile picture, edit profile (name + bio), privacy,
   change password, forgot password, show/hide password.
   Everything is saved on the server; nothing here only lives in the browser.
   ===================================================================== */

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MIN_PASSWORD = 8;
const MAX_BIO = 160;

let resendTimer = null;
let resetEmail = "";
let profileBusy = false;
let editSetupMode = false;

const PW_ICONS = {
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/>'
};

function pwIcon(name) {
    const t = document.createElement("template");
    t.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" ' +
        'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
        'stroke-linejoin="round" aria-hidden="true">' + PW_ICONS[name] + "</svg>";
    return t.content.firstChild;
}


/* ===================== show / hide password ======================== */

function enhancePasswordInputs() {

    document.querySelectorAll('input[type="password"]').forEach(input => {

        if (input.parentElement.classList.contains("password-field")) return;

        const wrap = el("div", "password-field");
        input.replaceWith(wrap);
        wrap.append(input);

        const toggle = el("button", "pw-toggle");
        toggle.type = "button";
        toggle.setAttribute("aria-label", "Show password");
        toggle.setAttribute("aria-pressed", "false");
        toggle.append(pwIcon("eye"));

        toggle.addEventListener("click", () => {

            const reveal = input.type === "password";

            input.type = reveal ? "text" : "password";

            toggle.setAttribute("aria-label", reveal ? "Hide password" : "Show password");
            toggle.setAttribute("aria-pressed", String(reveal));
            toggle.replaceChildren(pwIcon(reveal ? "eyeOff" : "eye"));

            input.focus();
        });

        wrap.append(toggle);
    });
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", enhancePasswordInputs);
} else {
    enhancePasswordInputs();
}


/* ---------------------- small shared helpers ----------------------- */

function setMsg(id, text, kind) {

    const box = document.getElementById(id);

    if (!box) return;

    box.textContent = text || "";
    box.className = "form-msg" + (text ? " " + kind : " hidden");
}

function setBusy(button, busy, busyText) {

    if (!button) return;

    if (busy) {
        button.dataset.label = button.textContent;
        button.textContent = busyText;
    } else if (button.dataset.label) {
        button.textContent = button.dataset.label;
    }

    button.disabled = busy;
}

function applyMe(me) {

    currentUser.name = me.full_name;
    currentUser.email = me.email;
    currentUser.username = me.username;
    currentUser.bio = me.bio || "";
    currentUser.avatar_url = me.avatar_url || null;
    currentUser.friends_count = me.friends_count;
    currentUser.posts_count = me.posts_count;

    updateProfile();
}

async function refreshMe() {

    try {
        applyMe(await api("/me"));
    } catch (error) {
        // the old values stay on screen
    }
}

function refreshAfterProfileChange() {
    // posts and stories drawn earlier still carry the old name or picture
    if (typeof loadHome === "function") loadHome(true);
}


/* ------------------- hooks called from social.js ------------------ */

async function onProfileOpened() {

    await refreshMe();

    // first visit without a photo: gentle one-time setup prompt
    const key = "playhub_setup_" + currentUser.username;

    if (currentUser.username && !currentUser.avatar_url && !localStorage.getItem(key)) {
        localStorage.setItem(key, "1");
        openEditProfile(true);
    }
}

function onProfileClosed() {

    stopResendTimer();

    ["editProfileModal", "privacyModal", "passwordModal", "nameModal"].forEach(closeModal);

    Object.assign(currentUser, {
        bio: "", avatar_url: null, friends_count: null, posts_count: null
    });
}


/* ======================= edit profile + picture ==================== */

function renderEditAvatar() {

    fillAvatar(document.getElementById("editAvatar"), {
        full_name: document.getElementById("editName").value || currentUser.name,
        avatar_url: currentUser.avatar_url
    });

    document.getElementById("removeAvatarBtn")
        .classList.toggle("hidden", !currentUser.avatar_url);
}

function updateBioCount() {

    const bio = document.getElementById("editBio");
    const count = document.getElementById("editBioCount");

    count.textContent = bio.value.length + "/" + MAX_BIO;
    count.classList.toggle("over", bio.value.length > MAX_BIO);
}

function openEditProfile(setup = false) {

    editSetupMode = setup === true;

    document.getElementById("editProfileTitle").textContent =
        editSetupMode ? "Set up your profile" : "Edit profile";

    document.getElementById("editProfileIntro")
        .classList.toggle("hidden", !editSetupMode);

    document.getElementById("editProfileCancel").textContent =
        editSetupMode ? "Skip for now" : "Cancel";

    document.getElementById("editName").value = currentUser.name || "";
    document.getElementById("editBio").value = currentUser.bio || "";

    setMsg("editProfileMsg", "");
    updateBioCount();
    renderEditAvatar();

    document.getElementById("editProfileModal").classList.remove("hidden");
}

function closeEditProfile() {
    closeModal("editProfileModal");
}

// The camera button and the "Profile photo" row go straight to the file picker
function changeProfilePhoto() {
    document.getElementById("avatarInput").click();
}

async function onAvatarPicked(event) {

    const file = event.target.files[0];
    event.target.value = "";

    if (!file || profileBusy || !checkImageFile(file)) return;

    profileBusy = true;

    const button = document.getElementById("uploadAvatarBtn");
    setBusy(button, true, "Uploading...");
    setMsg("editProfileMsg", "");

    try {
        const form = new FormData();
        form.append("image", file);

        const result = await api("/me/avatar", { method: "POST", formData: form });

        currentUser.avatar_url = result.avatar_url;
        updateProfile();
        renderEditAvatar();
        showToast("Profile photo updated");
        refreshAfterProfileChange();

    } catch (error) {
        setMsg("editProfileMsg", error.message, "error");
        showToast(error.message);
    }

    setBusy(button, false);
    profileBusy = false;
}

async function removeAvatar() {

    if (profileBusy || !currentUser.avatar_url) return;

    profileBusy = true;

    try {
        await api("/me/avatar", { method: "DELETE" });

        currentUser.avatar_url = null;
        updateProfile();
        renderEditAvatar();
        showToast("Profile photo removed");
        refreshAfterProfileChange();

    } catch (error) {
        setMsg("editProfileMsg", error.message, "error");
    }

    profileBusy = false;
}

async function saveProfile() {

    if (profileBusy) return;

    const name = document.getElementById("editName").value.trim();
    const bio = document.getElementById("editBio").value.trim();

    if (!name) {
        setMsg("editProfileMsg", "Please enter your name", "error");
        return;
    }

    if (bio.length > MAX_BIO) {
        setMsg("editProfileMsg", "Your bio can be up to " + MAX_BIO + " characters", "error");
        return;
    }

    profileBusy = true;

    const button = document.getElementById("editProfileSave");
    setBusy(button, true, "Saving...");

    try {
        const saved = await api("/me/profile", {
            method: "PUT",
            body: { full_name: name, bio: bio }
        });

        const nameChanged = saved.full_name !== currentUser.name;

        currentUser.name = saved.full_name;
        currentUser.bio = saved.bio;
        updateProfile();

        closeEditProfile();
        showToast("Profile updated");

        if (nameChanged) refreshAfterProfileChange();

    } catch (error) {
        setMsg("editProfileMsg", error.message, "error");
    }

    setBusy(button, false);
    profileBusy = false;
}

function viewMyProfile() {
    openUserProfile(currentUser.username);
}

// "Change name" row: same modal as before, now saved on the server
async function saveName() {

    const name = document.getElementById("newName").value.trim();

    if (!name) {
        showToast("Enter your name");
        return;
    }

    try {
        const saved = await api("/me/profile", { method: "PUT", body: { full_name: name } });

        currentUser.name = saved.full_name;
        updateProfile();
        closeModal("nameModal");
        showToast("Name updated");
        refreshAfterProfileChange();

    } catch (error) {
        showToast(error.message);
    }
}


/* ============================== privacy ============================ */

async function openPrivacySettings() {

    document.getElementById("privacyModal").classList.remove("hidden");

    const save = document.getElementById("privacySave");

    save.disabled = true;
    setMsg("privacyMsg", "Loading your settings...", "info");

    try {
        const p = await api("/me/privacy");

        document.getElementById("privEmail").value = p.email_visibility;
        document.getElementById("privFriends").value = p.friends_visibility;
        document.getElementById("privInfo").value = p.info_visibility;

        setMsg("privacyMsg", "");
        save.disabled = false;

    } catch (error) {
        setMsg("privacyMsg", error.message, "error");
    }
}

async function savePrivacy() {

    const button = document.getElementById("privacySave");
    setBusy(button, true, "Saving...");

    try {
        await api("/me/privacy", {
            method: "PUT",
            body: {
                email_visibility: document.getElementById("privEmail").value,
                friends_visibility: document.getElementById("privFriends").value,
                info_visibility: document.getElementById("privInfo").value
            }
        });

        closeModal("privacyModal");
        showToast("Privacy settings saved");

    } catch (error) {
        setMsg("privacyMsg", error.message, "error");
    }

    setBusy(button, false);
}


/* ========================== change password ======================== */

async function savePassword() {

    const current = document.getElementById("currentPassword").value;
    const next = document.getElementById("newPassword").value;
    const again = document.getElementById("confirmNewPassword").value;

    if (!current || !next || !again) {
        setMsg("passwordMsg", "Fill in all three fields", "error");
        return;
    }

    if (next.length < MIN_PASSWORD) {
        setMsg("passwordMsg", "Your new password must be at least " + MIN_PASSWORD + " characters", "error");
        return;
    }

    if (next !== again) {
        setMsg("passwordMsg", "The new passwords don't match", "error");
        return;
    }

    const button = document.getElementById("passwordSave");
    setBusy(button, true, "Updating...");

    try {
        const result = await api("/me/password", {
            method: "POST",
            body: { current_password: current, new_password: next }
        });

        // the old login was ended by the server; keep this one going
        localStorage.setItem(TOKEN_KEY, result.token);

        ["currentPassword", "newPassword", "confirmNewPassword"].forEach(id => {
            document.getElementById(id).value = "";
        });

        setMsg("passwordMsg", "");
        closeModal("passwordModal");
        showToast("Password updated");

    } catch (error) {
        setMsg("passwordMsg", error.message, "error");
    }

    setBusy(button, false);
}


/* ========================= forgot password ========================= */

function showAuthPanel(id) {
    hideAuthPanels();
    document.getElementById(id).classList.remove("hidden");
}

function stopResendTimer() {
    clearInterval(resendTimer);
    resendTimer = null;
}

function startResendTimer(seconds) {

    stopResendTimer();

    const button = document.getElementById("resendCode");
    let left = seconds;

    const tick = () => {
        if (left <= 0) {
            button.disabled = false;
            button.textContent = "Resend code";
            stopResendTimer();
            return;
        }

        button.disabled = true;
        button.textContent = "Resend code in " + left + "s";
        left--;
    };

    tick();

    if (left > 0) resendTimer = setInterval(tick, 1000);
}

function showForgotPassword() {

    stopVerifyPolling();
    showAuthPanel("forgotForm");

    const input = document.getElementById("forgotEmail");
    input.value = document.getElementById("loginEmail").value.trim();

    setMsg("forgotMsg", "");
    input.focus();
}

async function sendResetCode(isResend) {

    const email = isResend === true
        ? resetEmail
        : document.getElementById("forgotEmail").value.trim();

    const msgId = isResend === true ? "resetMsg" : "forgotMsg";

    if (!EMAIL_RE.test(email)) {
        setMsg(msgId, "Enter a valid email address", "error");
        return;
    }

    const button = document.getElementById(isResend === true ? "resendCode" : "forgotSend");
    setBusy(button, true, "Sending...");
    setMsg(msgId, "");

    try {
        const data = await api("/password/forgot", { method: "POST", body: { email: email } });

        resetEmail = email;

        document.getElementById("resetEmailText").textContent = email;
        ["resetCode", "resetNewPassword", "resetConfirmPassword"].forEach(id => {
            document.getElementById(id).value = "";
        });

        showAuthPanel("resetForm");
        setMsg("resetMsg", data.message + ". It expires in 15 minutes.", "success");

        setBusy(button, false);
        startResendTimer(data.resend_after || 60);

        document.getElementById("resetCode").focus();
        return;

    } catch (error) {
        setMsg(msgId, error.message, "error");
    }

    setBusy(button, false);
}

async function submitReset() {

    const code = document.getElementById("resetCode").value.trim();
    const next = document.getElementById("resetNewPassword").value;
    const again = document.getElementById("resetConfirmPassword").value;

    if (!/^\d{6}$/.test(code)) {
        setMsg("resetMsg", "Enter the 6-digit code from your email", "error");
        return;
    }

    if (next.length < MIN_PASSWORD) {
        setMsg("resetMsg", "Your new password must be at least " + MIN_PASSWORD + " characters", "error");
        return;
    }

    if (next !== again) {
        setMsg("resetMsg", "The two passwords don't match", "error");
        return;
    }

    const button = document.getElementById("resetSubmit");
    setBusy(button, true, "Resetting...");
    setMsg("resetMsg", "");

    try {
        await api("/password/reset", {
            method: "POST",
            body: { email: resetEmail, code: code, new_password: next }
        });

        stopResendTimer();
        showAuthPanel("resetDone");

    } catch (error) {
        setMsg("resetMsg", error.message, "error");

        // expired or locked codes need a fresh one: let them ask right away
        if (/new (one|code)/i.test(error.message)) {
            stopResendTimer();
            const resend = document.getElementById("resendCode");
            resend.disabled = false;
            resend.textContent = "Resend code";
        }
    }

    setBusy(button, false);
}

function backToLoginAfterReset() {

    showLogin();

    document.getElementById("loginEmail").value = resetEmail;
    document.getElementById("loginPassword").value = "";
    document.getElementById("loginPassword").focus();
}