/* Vynqo-wide in-app calling. Media stays in the browser; Flask only signals peers. */

/* Read the same authentication token used by the existing Vynqo login system. */
function callToken() {
    return localStorage.getItem(TOKEN_KEY);
}

const VYNQO_CALL = {
    socket: null, call: null, pc: null, stream: null, remoteStream: null,
    incoming: null, ringingTimer: null, elapsedTimer: null, startedAt: null,
    muted: false, cameraOff: false, connected: false, seen: new Set(), pendingIce: [], connectPromise: null, connectResolve: null, connectReject: null, pendingAccepted: null
};

function callEsc(value) {
    return String(value || "").replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
}

function ensureCallUI() {
    if (document.getElementById("vynqoCallRoot")) return;
    const root = document.createElement("div");
    root.id = "vynqoCallRoot";
    root.innerHTML = `
      <div id="vynqoIncomingCall" class="vcall-overlay hidden" role="dialog" aria-modal="true">
        <div class="vcall-card vcall-incoming"><div class="vcall-avatar">☎</div><small>INCOMING <span id="vcallIncomingType">AUDIO</span> CALL</small><h2 id="vcallIncomingName">Someone</h2><p>is calling you on Vynqo</p>
          <div class="vcall-actions"><button class="vcall-decline" id="vcallReject">Decline</button><button class="vcall-accept" id="vcallAccept">Accept</button></div></div>
      </div>
      <div id="vynqoActiveCall" class="vcall-active hidden" role="dialog" aria-modal="true">
        <div class="vcall-stage"><video id="vcallRemoteVideo" autoplay playsinline></video><div id="vcallAudioAvatar" class="vcall-audio-avatar">☎</div><video id="vcallLocalVideo" autoplay muted playsinline></video>
          <div class="vcall-top"><div><strong id="vcallPeerName">Calling...</strong><small id="vcallStatus">Connecting securely</small></div><button id="vcallMinimize" aria-label="Minimize call">−</button></div>
          <div class="vcall-controls"><button id="vcallMute">Mute</button><button id="vcallCamera">Camera off</button><button id="vcallHangup" class="vcall-hangup">End call</button></div>
        </div>
      </div>`;
    document.body.append(root);
    document.getElementById("vcallAccept").addEventListener("click", acceptIncomingCall);
    document.getElementById("vcallReject").addEventListener("click", rejectIncomingCall);
    document.getElementById("vcallHangup").addEventListener("click", endCurrentCall);
    document.getElementById("vcallMute").addEventListener("click", toggleCallMute);
    document.getElementById("vcallCamera").addEventListener("click", toggleCallCamera);
    document.getElementById("vcallMinimize").addEventListener("click", () => document.getElementById("vynqoActiveCall").classList.toggle("is-minimized"));
}

function connectVynqoCalling() {
    if (!callToken() || typeof io !== "function") return Promise.reject(new Error("Calling service is unavailable"));
    if (VYNQO_CALL.socket && VYNQO_CALL.socket.connected) return Promise.resolve();
    if (VYNQO_CALL.connectPromise) return VYNQO_CALL.connectPromise;
    if (VYNQO_CALL.socket) { VYNQO_CALL.socket.disconnect(); VYNQO_CALL.socket = null; }

    let connectionTimeout;
    VYNQO_CALL.connectPromise = new Promise((resolve, reject) => {
        VYNQO_CALL.connectResolve = resolve;
        VYNQO_CALL.connectReject = reject;
        connectionTimeout = setTimeout(() => {
            if (!VYNQO_CALL.connected) reject(new Error("Could not connect to Vynqo calling. Check that the server is running."));
        }, 10000);
    }).finally(() => { clearTimeout(connectionTimeout); VYNQO_CALL.connectPromise = null; });

    const socket = io(API_URL, {auth: {token: callToken()}, transports: ["websocket", "polling"], reconnection: true});
    VYNQO_CALL.socket = socket;
    socket.on("connect", () => {
        VYNQO_CALL.connected = true;
        VYNQO_CALL.connectResolve?.();
        VYNQO_CALL.connectResolve = null;
        VYNQO_CALL.connectReject = null;
        restoreActiveCall();
    });
    socket.on("connect_error", error => {
        VYNQO_CALL.connectReject?.(error);
        VYNQO_CALL.connectResolve = null;
        VYNQO_CALL.connectReject = null;
    });
    socket.on("disconnect", () => { VYNQO_CALL.connected = false; });
    socket.on("incoming_call", showIncomingCall);
    socket.on("call_accepted", onCallAccepted);
    socket.on("call_ended", onCallEnded);
    socket.on("rtc_signal", onRtcSignal);

    return VYNQO_CALL.connectPromise;
}

async function callApi(path, method="GET", body=null) {
    const response = await fetch(API_URL + path, {method, headers: {"Authorization":"Bearer " + callToken(), ...(body ? {"Content-Type":"application/json"} : {})}, body: body ? JSON.stringify(body) : undefined});
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || "Calling request failed");
    return data;
}

async function startVynqoCall(userId, type="audio") {
    ensureCallUI();
    try {
        await connectVynqoCalling();
        if (VYNQO_CALL.call || VYNQO_CALL.incoming) throw new Error("You are already handling a call");
        const data = await callApi("/calls", "POST", {user_id: userId, type});
        VYNQO_CALL.call = data.call;
        showActiveCall(data.call, "Ringing...");
        if (VYNQO_CALL.pendingAccepted?.call?.id === data.call.id) {
            const accepted = VYNQO_CALL.pendingAccepted;
            VYNQO_CALL.pendingAccepted = null;
            await onCallAccepted(accepted);
        }
        VYNQO_CALL.ringingTimer = setTimeout(() => {
            if (VYNQO_CALL.call && VYNQO_CALL.call.status === "ringing") endCurrentCall(true);
        }, 60000);
    } catch (error) { showToast(error.message); }
}

function showIncomingCall(call) {
    if (!call || VYNQO_CALL.seen.has(call.id)) return;
    VYNQO_CALL.seen.add(call.id);
    if (VYNQO_CALL.call && ["ringing", "accepted"].includes(VYNQO_CALL.call.status)) return;
    VYNQO_CALL.incoming = call;
    ensureCallUI();
    document.getElementById("vcallIncomingName").textContent = call.other_user.full_name;
    document.getElementById("vcallIncomingType").textContent = call.type.toUpperCase();
    document.getElementById("vynqoIncomingCall").classList.remove("hidden");
    if ("Notification" in window && Notification.permission === "granted" && document.hidden) {
        try { new Notification("Incoming Vynqo call", {body: call.other_user.full_name + " is calling you"}); } catch (_) {}
    }
}

async function acceptIncomingCall() {
    const call = VYNQO_CALL.incoming;
    if (!call) return;
    try {
        await callApi(`/calls/${call.id}/accept`, "POST");
        VYNQO_CALL.call = {...call, status:"accepted"};
        VYNQO_CALL.incoming = null;
        document.getElementById("vynqoIncomingCall").classList.add("hidden");
        showActiveCall(VYNQO_CALL.call, "Connecting...");
        if (VYNQO_CALL.socket) VYNQO_CALL.socket.emit("call_client_ready", {call_id: call.id});
        // The server's call_accepted event can arrive before this HTTP response.
        // Starting media here as well closes that race; onCallAccepted is guarded.
        await onCallAccepted({call: VYNQO_CALL.call});
    } catch (error) { showToast(error.message); document.getElementById("vynqoIncomingCall").classList.add("hidden"); }
}

async function rejectIncomingCall() {
    const call = VYNQO_CALL.incoming;
    VYNQO_CALL.incoming = null;
    document.getElementById("vynqoIncomingCall").classList.add("hidden");
    if (call) { try { await callApi(`/calls/${call.id}/reject`, "POST"); } catch (_) {} }
}

function showActiveCall(call, status) {
    ensureCallUI();
    document.getElementById("vcallPeerName").textContent = call.other_user.full_name;
    document.getElementById("vcallStatus").textContent = status || "In call";
    document.getElementById("vynqoActiveCall").classList.remove("hidden");
    document.getElementById("vynqoActiveCall").classList.remove("is-minimized");
    document.getElementById("vcallAudioAvatar").classList.toggle("hidden", call.type === "video");
}

async function getCallMedia(type) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("Camera and microphone require HTTPS or localhost.");
    VYNQO_CALL.stream = await navigator.mediaDevices.getUserMedia({audio:true, video:type === "video"});
    document.getElementById("vcallLocalVideo").srcObject = type === "video" ? VYNQO_CALL.stream : null;
    document.getElementById("vcallLocalVideo").classList.toggle("hidden", type !== "video");
}

function createPeerConnection() {
    const pc = new RTCPeerConnection({iceServers:[{urls:"stun:stun.l.google.com:19302"}]});
    VYNQO_CALL.pc = pc;
    VYNQO_CALL.remoteStream = new MediaStream();
    pc.ontrack = event => {
        event.streams[0].getTracks().forEach(track => VYNQO_CALL.remoteStream.addTrack(track));
        const video = document.getElementById("vcallRemoteVideo");
        video.srcObject = VYNQO_CALL.remoteStream;
        video.classList.toggle("hidden", VYNQO_CALL.call?.type !== "video");
        document.getElementById("vcallAudioAvatar").classList.toggle("hidden", VYNQO_CALL.call?.type === "video");
    };
    pc.onicecandidate = event => {
        if (event.candidate && VYNQO_CALL.socket && VYNQO_CALL.call) {
            VYNQO_CALL.socket.emit("rtc_signal", {call_id:VYNQO_CALL.call.id, kind:"ice", payload:event.candidate.toJSON()});
        }
    };
    pc.onconnectionstatechange = () => {
        const status = document.getElementById("vcallStatus");
        if (status && pc.connectionState === "connected") {
            status.textContent = "Connected";
            if (!VYNQO_CALL.startedAt) { VYNQO_CALL.startedAt = Date.now(); startCallDuration(); }
        } else if (status && ["failed", "disconnected"].includes(pc.connectionState)) status.textContent = "Connection interrupted";
    };
    VYNQO_CALL.stream.getTracks().forEach(track => pc.addTrack(track, VYNQO_CALL.stream));
    return pc;
}

async function onCallAccepted(data) {
    if (!VYNQO_CALL.call) { VYNQO_CALL.pendingAccepted = data; return; }
    if (data.call.id !== VYNQO_CALL.call.id) return;
    if (VYNQO_CALL.stream || VYNQO_CALL.pc) return;
    clearTimeout(VYNQO_CALL.ringingTimer);
    VYNQO_CALL.call.status = "accepted";
    showActiveCall(VYNQO_CALL.call, "Starting call...");
    try {
        await getCallMedia(VYNQO_CALL.call.type);
        const pc = createPeerConnection();
        if (VYNQO_CALL.call.direction === "outgoing") {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            VYNQO_CALL.socket.emit("rtc_signal", {call_id:VYNQO_CALL.call.id, kind:"offer", payload:pc.localDescription.toJSON()});
        }
    } catch (error) { showToast(error.message); await endCurrentCall(); }
}

async function onRtcSignal(data) {
    if (!VYNQO_CALL.call || data.call_id !== VYNQO_CALL.call.id) return;
    try {
        if (!VYNQO_CALL.pc && data.kind === "offer") {
            await getCallMedia(VYNQO_CALL.call.type);
            createPeerConnection();
        }
        if (!VYNQO_CALL.pc) return;
        if (data.kind === "offer") {
            await VYNQO_CALL.pc.setRemoteDescription(data.payload);
            for (const candidate of VYNQO_CALL.pendingIce.splice(0)) await VYNQO_CALL.pc.addIceCandidate(candidate);
            const answer = await VYNQO_CALL.pc.createAnswer();
            await VYNQO_CALL.pc.setLocalDescription(answer);
            VYNQO_CALL.socket.emit("rtc_signal", {call_id:VYNQO_CALL.call.id, kind:"answer", payload:VYNQO_CALL.pc.localDescription.toJSON()});
        } else if (data.kind === "answer") {
            await VYNQO_CALL.pc.setRemoteDescription(data.payload);
            for (const candidate of VYNQO_CALL.pendingIce.splice(0)) await VYNQO_CALL.pc.addIceCandidate(candidate);
        } else if (data.kind === "ice" && data.payload) {
            if (VYNQO_CALL.pc.remoteDescription) await VYNQO_CALL.pc.addIceCandidate(data.payload);
            else VYNQO_CALL.pendingIce.push(data.payload);
        }
    } catch (error) { console.error("WebRTC signalling error", error); }
}

function startCallDuration() {
    clearInterval(VYNQO_CALL.elapsedTimer);
    VYNQO_CALL.elapsedTimer = setInterval(() => {
        if (VYNQO_CALL.startedAt) {
            const sec = Math.floor((Date.now()-VYNQO_CALL.startedAt)/1000);
            document.getElementById("vcallStatus").textContent = `${Math.floor(sec/60)}:${String(sec%60).padStart(2,"0")}`;
        }
    }, 1000);
}

function toggleCallMute() {
    VYNQO_CALL.muted = !VYNQO_CALL.muted;
    (VYNQO_CALL.stream?.getAudioTracks() || []).forEach(t => t.enabled = !VYNQO_CALL.muted);
    document.getElementById("vcallMute").textContent = VYNQO_CALL.muted ? "Unmute" : "Mute";
}
function toggleCallCamera() {
    VYNQO_CALL.cameraOff = !VYNQO_CALL.cameraOff;
    (VYNQO_CALL.stream?.getVideoTracks() || []).forEach(t => t.enabled = !VYNQO_CALL.cameraOff);
    document.getElementById("vcallCamera").textContent = VYNQO_CALL.cameraOff ? "Camera on" : "Camera off";
}

async function endCurrentCall(silent=false) {
    const call = VYNQO_CALL.call;
    if (!call) return;
    try {
        const action = call.direction === "outgoing" && call.status === "ringing" ? "cancel" : "end";
        await callApi(`/calls/${call.id}/${action}`, "POST");
    } catch (_) {}
    cleanupCall();
}
function onCallEnded(data) {
    if ((VYNQO_CALL.call && data.call_id === VYNQO_CALL.call.id) || (VYNQO_CALL.incoming && data.call_id === VYNQO_CALL.incoming.id)) {
        cleanupCall();
        showToast(data.status === "rejected" ? "Call declined" : "Call ended");
    }
}
function cleanupCall() {
    clearTimeout(VYNQO_CALL.ringingTimer); clearInterval(VYNQO_CALL.elapsedTimer);
    VYNQO_CALL.stream?.getTracks().forEach(t => t.stop());
    VYNQO_CALL.pc?.close();
    VYNQO_CALL.stream = null; VYNQO_CALL.pc = null; VYNQO_CALL.remoteStream = null;
    VYNQO_CALL.call = null; VYNQO_CALL.incoming = null; VYNQO_CALL.startedAt = null; VYNQO_CALL.pendingIce = [];
    document.getElementById("vynqoIncomingCall")?.classList.add("hidden");
    document.getElementById("vynqoActiveCall")?.classList.add("hidden");
    const remote = document.getElementById("vcallRemoteVideo"); if (remote) remote.srcObject = null;
    const local = document.getElementById("vcallLocalVideo"); if (local) local.srcObject = null;
}

async function restoreActiveCall() {
    try {
        const data = await callApi("/calls/active");
        if (!data.call) return;
        if (data.call.status === "ringing" && data.call.direction === "incoming") showIncomingCall(data.call);
        else if (data.call.status === "ringing" && data.call.direction === "outgoing") { VYNQO_CALL.call = data.call; showActiveCall(data.call, "Ringing..."); }
        else if (data.call.status === "accepted") { VYNQO_CALL.call = data.call; showActiveCall(data.call, "Reconnecting..."); if (VYNQO_CALL.socket) VYNQO_CALL.socket.emit("call_client_ready", {call_id:data.call.id}); await onCallAccepted({call:data.call}); }
    } catch (_) {}
}

function onCallingAppOpened() { ensureCallUI(); connectVynqoCalling(); }
function onCallingLoggedOut() {
    if (VYNQO_CALL.socket) VYNQO_CALL.socket.disconnect();
    VYNQO_CALL.socket = null; VYNQO_CALL.connected = false; VYNQO_CALL.connectPromise = null; VYNQO_CALL.connectResolve = null; VYNQO_CALL.connectReject = null; VYNQO_CALL.pendingAccepted = null; cleanupCall(); VYNQO_CALL.seen.clear();
}

// Used by friend/message UI without coupling calling to a particular screen.
window.startVynqoCall = startVynqoCall;
