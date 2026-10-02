let balance = 0;

let transactions = [];

let posts = [];

let selectedPostId = null;

let selectedImage = null;

let currentUser = {
    name: "User",
    email: "user@example.com",
    photo: null
};


/* ================= AUTH ================= */

function showLogin() {
    document.getElementById("loginForm").classList.remove("hidden");
    document.getElementById("signupForm").classList.add("hidden");
}


function showSignup() {
    document.getElementById("loginForm").classList.add("hidden");
    document.getElementById("signupForm").classList.remove("hidden");
}


function login() {

    const email = document.getElementById("loginEmail").value;

    if (!email) {
        showToast("Enter your email");
        return;
    }

    currentUser.email = email;

    openApp();
}


function signup() {

    const name = document.getElementById("signupName").value;
    const email = document.getElementById("signupEmail").value;

    if (!name || !email) {
        showToast("Complete the required fields");
        return;
    }

    currentUser.name = name;
    currentUser.email = email;

    updateProfile();

    openApp();
}


function openApp() {

    document.getElementById("authScreen").classList.add("hidden");

    document.getElementById("appScreen").classList.remove("hidden");

    updateBalance();

    updateProfile();
}


function logout() {

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


/* ================= POSTS ================= */

function openPostModal(withPhoto = false) {

    document.getElementById("postModal")
        .classList.remove("hidden");

    if (withPhoto) {
        document.getElementById("postImage").click();
    }
}


function createPost() {

    const text =
        document.getElementById("postText").value.trim();


    if (!text && !selectedImage) {
        showToast("Write something or add a photo");
        return;
    }


    const post = {

        id: Date.now(),

        text: text,

        image: selectedImage,

        likes: 0,

        comments: []

    };


    posts.unshift(post);

    renderPosts();

    document.getElementById("postText").value = "";

    removeSelectedImage();

    closeModal("postModal");

    showToast("Post created");
}


function renderPosts() {

    const container =
        document.getElementById("feedContainer");


    if (posts.length === 0) {

        container.innerHTML = `

            <div class="empty-state">

                <div class="empty-icon">📝</div>

                <h3>Your feed is empty</h3>

                <p>
                    Posts from people you connect with
                    will appear here.
                </p>

                <button
                    class="primary-btn small-btn"
                    onclick="openPostModal()">

                    Create your first post

                </button>

            </div>

        `;

        return;
    }


    container.innerHTML = "";


    posts.forEach(post => {

        const article =
            document.createElement("article");

        article.className = "post-card";

        article.style.cssText = `
            background: var(--card);
            border: 1px solid var(--border);
            border-radius: 18px;
            margin-bottom: 15px;
            overflow: hidden;
        `;


        let imageHTML = "";

        if (post.image) {

            imageHTML = `
                <img
                    src="${post.image}"
                    style="
                        width:100%;
                        max-height:450px;
                        object-fit:cover;
                    "
                    alt="Post image">
            `;

        }


        article.innerHTML = `

            <div style="
                display:flex;
                align-items:center;
                gap:10px;
                padding:15px;
            ">

                <div class="avatar">
                    ${currentUser.name.charAt(0).toUpperCase()}
                </div>

                <div>
                    <strong>${escapeHTML(currentUser.name)}</strong>

                    <small style="
                        display:block;
                        color:var(--muted);
                    ">
                        Just now
                    </small>
                </div>

            </div>


            ${
                post.text
                    ? `
                    <p style="
                        padding:0 15px 15px;
                        line-height:1.6;
                    ">
                        ${escapeHTML(post.text)}
                    </p>
                    `
                    : ""
            }


            ${imageHTML}


            <div style="
                display:flex;
                border-top:1px solid var(--border);
            ">

                <button
                    onclick="likePost(${post.id})"
                    style="
                        flex:1;
                        padding:13px;
                        background:transparent;
                        color:var(--text);
                    ">

                    ❤️ ${post.likes}

                </button>


                <button
                    onclick="openComments(${post.id})"
                    style="
                        flex:1;
                        padding:13px;
                        background:transparent;
                        color:var(--text);
                    ">

                    💬 ${post.comments.length}

                </button>


                <button
                    onclick="showToast('Share will connect to the backend')"
                    style="
                        flex:1;
                        padding:13px;
                        background:transparent;
                        color:var(--text);
                    ">

                    ↗ Share

                </button>

            </div>

        `;


        container.appendChild(article);

    });

}


function likePost(id) {

    const post =
        posts.find(item => item.id === id);

    if (!post) return;

    post.likes++;

    renderPosts();
}


/* ================= COMMENTS ================= */

function openComments(postId) {

    selectedPostId = postId;

    renderComments();

    document.getElementById("commentModal")
        .classList.remove("hidden");
}


function renderComments() {

    const container =
        document.getElementById("commentsContainer");


    const post =
        posts.find(item => item.id === selectedPostId);


    if (!post) return;


    if (post.comments.length === 0) {

        container.innerHTML = `

            <div class="empty-state compact">

                <div class="empty-icon">💬</div>

                <h3>No comments yet</h3>

                <p>
                    Be the first person to comment.
                </p>

            </div>

        `;

        return;
    }


    container.innerHTML = "";


    post.comments.forEach(comment => {

        const div =
            document.createElement("div");

        div.className = "comment";

        div.innerHTML = `

            <strong>
                ${escapeHTML(comment.name)}
            </strong>

            <p>
                ${escapeHTML(comment.text)}
            </p>

        `;

        container.appendChild(div);

    });

}


function addComment() {

    const input =
        document.getElementById("commentInput");


    const text =
        input.value.trim();


    if (!text) return;


    const post =
        posts.find(item => item.id === selectedPostId);


    if (!post) return;


    post.comments.push({

        name: currentUser.name,

        text: text

    });


    input.value = "";

    renderComments();

    renderPosts();

}


/* ================= PHOTO ================= */

function previewPostImage(event) {

    const file =
        event.target.files[0];


    if (!file) return;


    const reader =
        new FileReader();


    reader.onload = function(e) {

        selectedImage = e.target.result;


        document.getElementById("previewImage").src =
            selectedImage;


        document.getElementById("imagePreview")
            .classList.remove("hidden");

    };


    reader.readAsDataURL(file);
}


function removeSelectedImage() {

    selectedImage = null;

    document.getElementById("postImage").value = "";

    document.getElementById("imagePreview")
        .classList.add("hidden");

    document.getElementById("previewImage").src = "";
}


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

                <div class="empty-icon">💳</div>

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


    const avatar =
        document.getElementById("profileAvatar");


    avatar.textContent =
        currentUser.name.charAt(0).toUpperCase();

}


function changeName() {

    document.getElementById("newName").value =
        currentUser.name;

    document.getElementById("nameModal")
        .classList.remove("hidden");
}


function saveName() {

    const name =
        document.getElementById("newName")
            .value.trim();


    if (!name) {

        showToast("Enter your name");

        return;
    }


    currentUser.name = name;

    updateProfile();

    renderPosts();

    closeModal("nameModal");

    showToast("Name updated");

}


function changePassword() {

    document.getElementById("passwordModal")
        .classList.remove("hidden");

}


function savePassword() {

    closeModal("passwordModal");

    showToast(
        "Password updated in frontend demo"
    );

}


function changeProfilePhoto() {

    showToast(
        "Profile photo upload will connect to the backend"
    );

}


function openEditProfile() {

    changeName();

}


/* ================= NOTIFICATIONS ================= */

function openNotifications() {

    document.getElementById("notificationModal")
        .classList.remove("hidden");

}


/* ================= STORIES ================= */

function createStory() {

    showToast(
        "Story photo upload will connect to the backend"
    );

}


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


    if (!name || !email || !password) {
        showToast("Complete all fields");
        return;
    }


    try {

        const response = await fetch(
            "http://127.0.0.1:5000/signup",
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


        currentUser.name = name;
        currentUser.email = email;

        updateProfile();


        showToast(
            "Account created! Username: " + data.username
        );


        document.getElementById("signupName").value = "";
        document.getElementById("signupEmail").value = "";
        document.getElementById("signupPassword").value = "";


        showLogin();

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


});