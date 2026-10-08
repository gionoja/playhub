let balance = 0;

let transactions = [];

let posts = [];

let selectedPostId = null;

let selectedImage = null;

let currentUser = {
    name: "User",
    email: "user@example.com",
    photo: null,
    username: "",
    bio: "",
    avatar_url: null,
    friends_count: null,
    posts_count: null
};


/* ================= AUTH ================= */

const API_URL = "http://127.0.0.1:5000";

const TOKEN_KEY = "playhub_token";

let verifyTimer = null;
let verifyEmail = "";


function hideAuthPanels() {
    ["loginForm", "signupForm", "verifyPending", "verifyDone",
     "forgotForm", "resetForm", "resetDone"].forEach(id => {
        document.getElementById(id).classList.add("hidden");
    });
}


function showLogin() {
    stopVerifyPolling();
    if (typeof stopResendTimer === "function") stopResendTimer();
    hideAuthPanels();
    document.getElementById("loginForm").classList.remove("hidden");
}


function showSignup() {
    stopVerifyPolling();
    if (typeof stopResendTimer === "function") stopResendTimer();
    hideAuthPanels();
    document.getElementById("signupForm").classList.remove("hidden");
}


async function login() {

    const email = document.getElementById("loginEmail").value.trim();
    const password = document.getElementById("loginPassword").value;

    if (!email || !password) {
        showToast("Enter your email and password");
        return;
    }

    try {

        const response = await fetch(API_URL + "/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: email, password: password })
        });

        const data = await response.json();

        if (!response.ok) {

            // Correct password, but the email link hasn't been tapped yet
            if (data.code === "email_not_verified") {
                showVerifyPending(email);
                return;
            }

            showToast(data.message || "Login failed");
            return;
        }

        localStorage.setItem(TOKEN_KEY, data.token);

                currentUser.name = data.user.full_name;
        currentUser.email = data.user.email;
        currentUser.username = data.user.username;
        currentUser.avatar_url = data.user.avatar_url || null;


        document.getElementById("loginPassword").value = "";

        openApp();

    } catch (error) {

        console.error(error);

        showToast("Unable to connect to PLAYHUB server");
    }
}


// Keeps people logged in after a page refresh
async function restoreSession() {

    const token = localStorage.getItem(TOKEN_KEY);

    if (!token) return;

    try {

        const response = await fetch(API_URL + "/me", {
            headers: { "Authorization": "Bearer " + token }
        });

        if (!response.ok) {
            localStorage.removeItem(TOKEN_KEY);
            return;
        }

        const data = await response.json();

                currentUser.name = data.full_name;
        currentUser.email = data.email;
        currentUser.username = data.username;
        currentUser.bio = data.bio || "";
        currentUser.avatar_url = data.avatar_url || null;
        currentUser.friends_count = data.friends_count;
        currentUser.posts_count = data.posts_count;


        openApp();

    } catch (error) {
        // Server not reachable: stay on the login screen
    }
}


/* ----- waiting for the email link to be tapped ----- */

function showVerifyPending(email) {

    verifyEmail = email;

    document.getElementById("verifyEmailText").textContent = email;

    hideAuthPanels();
    document.getElementById("verifyPending").classList.remove("hidden");

    stopVerifyPolling();
    verifyTimer = setInterval(checkVerification, 3000);
}


function stopVerifyPolling() {

    if (verifyTimer) {
        clearInterval(verifyTimer);
        verifyTimer = null;
    }
}


async function checkVerification() {

    if (!verifyEmail) return;

    try {

        const response = await fetch(
            API_URL + "/verification-status?email=" + encodeURIComponent(verifyEmail)
        );

        const data = await response.json();

        if (data.verified) {
            stopVerifyPolling();
            hideAuthPanels();
            document.getElementById("verifyDone").classList.remove("hidden");
        }

    } catch (error) {
        // Server unreachable for a moment: keep waiting and try again
    }
}


function goToLoginAfterVerify() {

    showLogin();

    document.getElementById("loginEmail").value = verifyEmail;
    document.getElementById("loginPassword").focus();
}


// Check right away when the person comes back to this tab after tapping the link
document.addEventListener("visibilitychange", () => {

    const waiting = !document
        .getElementById("verifyPending")
        .classList.contains("hidden");

    if (!document.hidden && waiting) {
        checkVerification();
    }
});


function openApp() {

    document.getElementById("authScreen").classList.add("hidden");

    document.getElementById("appScreen").classList.remove("hidden");

    updateBalance();

    updateProfile();

    if (typeof onAppOpened === "function") onAppOpened();
}


function logout() {

    localStorage.removeItem(TOKEN_KEY);

    if (typeof onLoggedOut === "function") onLoggedOut();

    document.getElementById("appScreen").classList.add("hidden");

    document.getElementById("authScreen").classList.remove("hidden");

    showLogin();
}


/* ================= NAVIGATION ================= */

function showScreen(screenName) {

    const screens = document.querySelectorAll(".screen");

    screens.forEach(screen => {
        screen.classList.remove("active");
    });


    const selectedScreen =
        document.getElementById(screenName + "Screen");

    if (selectedScreen) {
        selectedScreen.classList.add("active");
    }


    const navItems = document.querySelectorAll(".nav-item");

    navItems.forEach(item => {
        item.classList.remove("active");

        if (item.dataset.screen === screenName) {
            item.classList.add("active");
        }
    });


    if (screenName === "friends" && typeof loadFriendsScreen === "function") {
        loadFriendsScreen();
    }


    if (screenName === "messages" && typeof loadConversations === "function") {
        loadConversations();
    }


    if (screenName === "home" && typeof loadHome === "function") {
        loadHome();
    }


    window.scrollTo(0, 0);
}


/* ================= DARK MODE ================= */

function toggleDarkMode() {

    document.body.classList.toggle("dark");

    const dark =
        document.body.classList.contains("dark");

    document.getElementById("darkModeToggle").checked = dark;

    document.getElementById("themeText").textContent =
        dark
            ? "Dark appearance enabled"
            : "Use dark appearance";

    localStorage.setItem("darkMode", dark);

}


function loadTheme() {

    const dark =
        localStorage.getItem("darkMode") === "true";

    if (dark) {
        document.body.classList.add("dark");

        const toggle =
            document.getElementById("darkModeToggle");

        if (toggle) {
            toggle.checked = true;
        }

        const text =
            document.getElementById("themeText");

        if (text) {
            text.textContent = "Dark appearance enabled";
        }
    }
}


/* ================= POSTS, COMMENTS, LIKES, STORIES =================
   These now live in feed.js and talk to the backend. */


/* ================= GAMES ================= */

function openGame(gameName) {

    document.getElementById("gameModalTitle")
        .textContent = gameName;

    document.getElementById("gameMessage")
        .textContent =
        `Create a ${gameName} challenge`;

    document.getElementById("gameModal")
        .classList.remove("hidden");
}


/* ================= BALANCE ================= */

function updateBalance() {

    const formatted =
        "₦" + balance.toLocaleString("en-NG", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        });


    document.getElementById("balanceAmount")
        .textContent = formatted;


    document.getElementById("homeBalance")
        .textContent = formatted;


    renderTransactions();
}


function openDepositModal() {

    document.getElementById("depositModal")
        .classList.remove("hidden");
}


function deposit() {

    const amount =
        Number(
            document.getElementById("depositAmount").value
        );


    if (!amount || amount <= 0) {

        showToast("Enter a valid amount");

        return;
    }


    balance += amount;


    transactions.unshift({

        type: "Deposit",

        amount: amount,

        status: "Pending",

        date: new Date().toLocaleString()

    });


    document.getElementById("depositAmount").value = "";

    closeModal("depositModal");

    updateBalance();

    showToast("Deposit recorded");


}


function openWithdrawModal() {

    document.getElementById("withdrawModal")
        .classList.remove("hidden");
}


function withdraw() {

    const amount =
        Number(
            document.getElementById("withdrawAmount").value
        );


    if (!amount || amount <= 0) {

        showToast("Enter a valid amount");

        return;
    }


    if (amount > balance) {

        showToast("Insufficient balance");

        return;
    }


    balance -= amount;


    transactions.unshift({

        type: "Withdrawal",

        amount: amount,

        status: "Pending",

        date: new Date().toLocaleString()

    });


    document.getElementById("withdrawAmount").value = "";

    closeModal("withdrawModal");

    updateBalance();

    showToast("Withdrawal recorded");

}


function renderTransactions() {

    const container =
        document.getElementById("transactionsContainer");


    if (!container) return;


    if (transactions.length === 0) {

        container.innerHTML = `

            <div class="empty-state compact">

                <div class="empty-icon"><svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/></svg></div>

                <h3>No transactions yet</h3>

                <p>
                    Your deposits and withdrawals
                    will appear here.
                </p>

            </div>

        `;

        return;
    }


    container.innerHTML = "";


    transactions.forEach(transaction => {

        const item =
            document.createElement("div");


        item.style.cssText = `
            background:var(--card);
            border:1px solid var(--border);
            padding:16px;
            border-radius:13px;
            display:flex;
            justify-content:space-between;
            margin-bottom:10px;
        `;


        item.innerHTML = `

            <div>

                <strong>
                    ${transaction.type}
                </strong>

                <small style="
                    display:block;
                    color:var(--muted);
                    margin-top:5px;
                ">
                    ${transaction.date}
                </small>

            </div>


            <div style="text-align:right">

                <strong>
                    ₦${transaction.amount.toLocaleString()}
                </strong>

                <small style="
                    display:block;
                    color:var(--muted);
                    margin-top:5px;
                ">
                    ${transaction.status}
                </small>

            </div>

        `;


        container.appendChild(item);

    });

}


/* ================= PROFILE ================= */

function updateProfile() {

    document.getElementById("profileName")
        .textContent = currentUser.name;


    document.getElementById("profileEmail")
        .textContent = currentUser.email;


    const username = document.getElementById("profileUsername");

    if (username) {
        username.textContent =
            currentUser.username ? "@" + currentUser.username : "";
    }


    const bio = document.getElementById("profileBio");

    if (bio) {
        bio.textContent = currentUser.bio || "";
        bio.classList.toggle("hidden", !currentUser.bio);
    }


    const friends = document.getElementById("profileFriendsCount");
    const postsCount = document.getElementById("profilePostsCount");

    if (friends) friends.textContent = currentUser.friends_count ?? 0;
    if (postsCount) postsCount.textContent = currentUser.posts_count ?? 0;


    // profile picture (or the first letter of the name) wherever "you" appear
    const me = { full_name: currentUser.name, avatar_url: currentUser.avatar_url };

    document.querySelectorAll("#profileAvatar, .avatar").forEach(node => {
        if (typeof fillAvatar === "function") {
            fillAvatar(node, me);
        } else {
            node.textContent = (currentUser.name || "?").charAt(0).toUpperCase();
        }
    });
}


function changeName() {

    document.getElementById("newName").value =
        currentUser.name;

    document.getElementById("nameModal")
        .classList.remove("hidden");
}




function changePassword() {

    if (typeof setMsg === "function") setMsg("passwordMsg", "");


    document.getElementById("passwordModal")
        .classList.remove("hidden");

}








/* ================= NOTIFICATIONS ================= */

function openNotifications() {

    document.getElementById("notificationModal")
        .classList.remove("hidden");

    if (typeof onNotificationsOpened === "function") onNotificationsOpened();

}


/* ================= STORIES ================= */

/* ================= MODAL ================= */

function closeModal(id) {

    document.getElementById(id)
        .classList.add("hidden");

}


/* ================= TOAST ================= */

function showToast(message) {

    const toast =
        document.getElementById("toast");


    toast.textContent = message;

    toast.classList.add("show");


    setTimeout(() => {

        toast.classList.remove("show");

    }, 2500);

}


/* ================= SECURITY ================= */

function escapeHTML(text) {

    const div =
        document.createElement("div");

    div.textContent = text;

    return div.innerHTML;

}


/* ================= SIGNUP ================= */

async function signup() {

    const name =
        document.getElementById("signupName").value.trim();

    const email =
        document.getElementById("signupEmail").value.trim();

        const password =
        document.getElementById("signupPassword").value;

    const confirm =
        document.getElementById("signupConfirm").value;



        if (!name || !email || !password || !confirm) {
        showToast("Complete all fields");
        return;
    }

    if (password !== confirm) {
        showToast("Passwords do not match");
        return;
    }



    try {

        const response = await fetch(
            API_URL + "/signup",
            {
                method: "POST",

                headers: {
                    "Content-Type": "application/json"
                },

                body: JSON.stringify({
                    full_name: name,
                    email: email,
                    password: password
                })
            }
        );


        const data = await response.json();


        if (!response.ok) {

            showToast(data.message);

            return;
        }


        document.getElementById("signupName").value = "";
        document.getElementById("signupEmail").value = "";
                document.getElementById("signupPassword").value = "";
        document.getElementById("signupConfirm").value = "";



        showVerifyPending(email);

    } catch (error) {

        console.error(error);

        showToast(
            "Unable to connect to PLAYHUB server"
        );
    }
}



/* ================= STARTUP ================= */

document.addEventListener("DOMContentLoaded", () => {

    loadTheme();

    updateBalance();

    updateProfile();

    restoreSession();

});