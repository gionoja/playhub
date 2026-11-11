/* Vynqo-wide in-app calling. Media stays in the browser; Flask only signals peers. */

/* Read the same authentication token used by the existing Vynqo login system. */
function callToken() {
    return localStorage.getItem(TOKEN_KEY);
}

const VYNQO_CALL = {
    socket: null, call: null, pc: null, stream: null, remoteStream: null,
    incoming: null, ringingTimer: null, elapsedTimer: null, disconnectTimer: null, startedAt: null,
    muted: false, cameraOff: false, connected: false, seen: new Set(), pendingIce: [],
    connectPromise: null, connectResolve: null, connectReject: null, pendingAccepted: null,
    mediaPromise: null, iceServers: null, offerStarted: false, pendingEnded: new Map(), creatingCall: false
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
        <div class="vcall-stage"><video id="vcallRemoteVideo" autoplay playsinline></video><audio id="vcallRemoteAudio" autoplay></audio><div id="vcallAudioAvatar" class="vcall-audio-avatar">☎</div><video id="vcallLocalVideo" autoplay muted playsinline></video>
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
        VYNQO_CALL.creatingCall = true;
        const data = await callApi("/calls", "POST", {user_id: userId, type});
        VYNQO_CALL.creatingCall = false;
        VYNQO_CALL.call = data.call;
        showActiveCall(data.call, "Ringing...");
        refreshCallLogsIfOpen();
        const endedEarly = VYNQO_CALL.pendingEnded.get(data.call.id);
        if (endedEarly) {
            VYNQO_CALL.pendingEnded.delete(data.call.id);
            onCallEnded(endedEarly);
            return;
        }
        if (VYNQO_CALL.pendingAccepted?.call?.id === data.call.id) {
            const accepted = VYNQO_CALL.pendingAccepted;
            VYNQO_CALL.pendingAccepted = null;
            await onCallAccepted(accepted);
        }
    } catch (error) {
        VYNQO_CALL.creatingCall = false;
        showToast(error.message);
    }
}

function showIncomingCall(call) {
    if (!call || VYNQO_CALL.seen.has(call.id)) return;
    VYNQO_CALL.seen.add(call.id);
    if (VYNQO_CALL.call && ["ringing", "accepted"].includes(VYNQO_CALL.call.status)) return;
    VYNQO_CALL.incoming = call;
    ensureCallUI();
    clearTimeout(VYNQO_CALL.ringingTimer);
    const timeoutMs = Math.max(0, (Number(call.ring_timeout_seconds || 60) * 1000) -
        (Date.now() - new Date(call.created_at).getTime()));
    VYNQO_CALL.ringingTimer = setTimeout(() => {
        if (VYNQO_CALL.incoming?.id === call.id) {
            VYNQO_CALL.incoming = null;
            document.getElementById("vynqoIncomingCall")?.classList.add("hidden");
            showToast("Missed call");
        }
    }, timeoutMs);
    document.getElementById("vcallIncomingName").textContent = call.other_user.full_name;
    document.getElementById("vcallIncomingType").textContent = call.type.toUpperCase();
    document.getElementById("vynqoIncomingCall").classList.remove("hidden");
    refreshCallLogsIfOpen();
    if ("Notification" in window && Notification.permission === "granted" && document.hidden) {
        try { new Notification("Incoming Vynqo call", {body: call.other_user.full_name + " is calling you"}); } catch (_) {}
    }
}

async function acceptIncomingCall() {
    const call = VYNQO_CALL.incoming;
    if (!call) return;
    // Publish the call locally before the HTTP request completes. The server may
    // relay the caller's SDP offer immediately after committing the acceptance.
    VYNQO_CALL.call = {...call, status:"ringing", direction:"incoming"};
    try {
        clearTimeout(VYNQO_CALL.ringingTimer);
        await callApi(`/calls/${call.id}/accept`, "POST");
        VYNQO_CALL.call.status = "accepted";
        VYNQO_CALL.incoming = null;
        document.getElementById("vynqoIncomingCall").classList.add("hidden");
        showActiveCall(VYNQO_CALL.call, "Connecting...");
        if (VYNQO_CALL.socket) VYNQO_CALL.socket.emit("call_client_ready", {call_id: call.id});
        // The server's call_accepted event can arrive before this HTTP response.
        // Starting media here as well closes that race; onCallAccepted is guarded.
        await onCallAccepted({call: VYNQO_CALL.call});
    } catch (error) {
        showToast(error.message);
        cleanupCall();
        document.getElementById("vynqoIncomingCall").classList.add("hidden");
    }
}

async function rejectIncomingCall() {
    const call = VYNQO_CALL.incoming;
    clearTimeout(VYNQO_CALL.ringingTimer);
    document.getElementById("vynqoIncomingCall").classList.add("hidden");
    if (call) {
        try { await callApi(`/calls/${call.id}/reject`, "POST"); }
        catch (error) { showToast(error.message); }
        if (VYNQO_CALL.incoming?.id === call.id) VYNQO_CALL.incoming = null;
        refreshCallLogsIfOpen();
    }
}

function showActiveCall(call, status) {
    ensureCallUI();
    document.getElementById("vcallPeerName").textContent = call.other_user.full_name;
    document.getElementById("vcallStatus").textContent = status || "In call";
    document.getElementById("vynqoActiveCall").classList.remove("hidden");
    document.getElementById("vynqoActiveCall").classList.remove("is-minimized");
    document.getElementById("vcallAudioAvatar").classList.toggle("hidden", call.type === "video");
    document.getElementById("vcallRemoteVideo").classList.toggle("hidden", call.type !== "video");
}

async function getCallMedia(type) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("Camera and microphone require HTTPS or localhost.");
    }
    const callId = VYNQO_CALL.call?.id;
    let stream;
    try {
        stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            video: type === "video" ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" } : false
        });
    } catch (error) {
        if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
            throw new Error("Allow camera and microphone access in your browser, then try again.");
        }
        if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
            throw new Error("A required camera or microphone could not be found.");
        }
        if (error.name === "NotReadableError" || error.name === "TrackStartError") {
            throw new Error("Your camera or microphone is already being used by another app.");
        }
        throw new Error(error.message || "Could not access your camera and microphone.");
    }
    if (!callId || VYNQO_CALL.call?.id !== callId) {
        stream.getTracks().forEach(track => track.stop());
        return null;
    }
    VYNQO_CALL.stream = stream;
    const local = document.getElementById("vcallLocalVideo");
    local.srcObject = type === "video" ? stream : null;
    local.classList.toggle("hidden", type !== "video");
    if (type === "video") local.play().catch(() => {});
    return stream;
}

async function getCallIceServers() {
    if (VYNQO_CALL.iceServers) return VYNQO_CALL.iceServers;
    try {
        const data = await callApi("/calls/config");
        VYNQO_CALL.iceServers = data.ice_servers;
    } catch (_) {
        VYNQO_CALL.iceServers = [
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "stun:stun.cloudflare.com:3478" }
        ];
    }
    return VYNQO_CALL.iceServers;
}

async function ensureCallPeerConnection() {
    if (VYNQO_CALL.pc) return VYNQO_CALL.pc;
    const callId = VYNQO_CALL.call?.id;
    if (!callId) return null;
    if (!VYNQO_CALL.mediaPromise) {
        const pending = (async () => {
            if (!VYNQO_CALL.stream) {
                const stream = await getCallMedia(VYNQO_CALL.call.type);
                if (!stream) return null;
            }
            if (VYNQO_CALL.call?.id !== callId) {
                VYNQO_CALL.stream?.getTracks().forEach(track => track.stop());
                VYNQO_CALL.stream = null;
                return null;
            }
            const iceServers = await getCallIceServers();
            if (VYNQO_CALL.call?.id !== callId) {
                VYNQO_CALL.stream?.getTracks().forEach(track => track.stop());
                VYNQO_CALL.stream = null;
                return null;
            }
            if (!VYNQO_CALL.pc) createPeerConnection(iceServers);
            return VYNQO_CALL.call?.id === callId ? VYNQO_CALL.pc : null;
        })();
        VYNQO_CALL.mediaPromise = pending;
        pending.finally(() => {
            if (VYNQO_CALL.mediaPromise === pending) VYNQO_CALL.mediaPromise = null;
        });
    }
    return VYNQO_CALL.mediaPromise;
}

function createPeerConnection(iceServers) {
    if (VYNQO_CALL.pc) return VYNQO_CALL.pc;
    const pc = new RTCPeerConnection({ iceServers, iceCandidatePoolSize: 10, bundlePolicy: "max-bundle" });
    VYNQO_CALL.pc = pc;
    VYNQO_CALL.remoteStream = new MediaStream();
    pc.ontrack = event => {
        if (event.track && !VYNQO_CALL.remoteStream.getTracks().some(t => t.id === event.track.id)) {
            VYNQO_CALL.remoteStream.addTrack(event.track);
        }
        const stream = event.streams?.[0] || VYNQO_CALL.remoteStream;
        const video = document.getElementById("vcallRemoteVideo");
        const audio = document.getElementById("vcallRemoteAudio");
        if (VYNQO_CALL.call?.type === "video") {
            video.srcObject = stream;
            video.classList.remove("hidden");
            audio.srcObject = null;
            video.play().catch(error => console.warn("Remote video autoplay was blocked", error));
        } else {
            audio.srcObject = stream;
            audio.play().catch(error => console.warn("Remote audio autoplay was blocked", error));
        }
        document.getElementById("vcallAudioAvatar").classList.toggle("hidden", VYNQO_CALL.call?.type === "video");
    };
    pc.onicecandidate = event => {
        if (event.candidate && VYNQO_CALL.socket && VYNQO_CALL.call) {
            VYNQO_CALL.socket.emit("rtc_signal", {
                call_id: VYNQO_CALL.call.id, kind: "ice", payload: event.candidate.toJSON()
            });
        }
    };
    pc.onconnectionstatechange = () => {
        const status = document.getElementById("vcallStatus");
        if (pc.connectionState === "connected") {
            clearTimeout(VYNQO_CALL.disconnectTimer);
            if (status) status.textContent = "Connected";
            if (!VYNQO_CALL.startedAt) {
                VYNQO_CALL.startedAt = Date.now();
                startCallDuration();
            }
        } else if (pc.connectionState === "disconnected") {
            if (status) status.textContent = "Connection interrupted — reconnecting…";
            clearTimeout(VYNQO_CALL.disconnectTimer);
            VYNQO_CALL.disconnectTimer = setTimeout(() => {
                if (VYNQO_CALL.pc === pc && pc.connectionState === "disconnected") {
                    showToast("Call connection was lost");
                    endCurrentCall();
                }
            }, 12000);
        } else if (pc.connectionState === "failed") {
            if (status) status.textContent = "Connection failed";
            showToast("Could not establish the call connection");
            endCurrentCall();
        }
    };
    VYNQO_CALL.stream.getTracks().forEach(track => pc.addTrack(track, VYNQO_CALL.stream));
    return pc;
}

async function onCallAccepted(data) {
    if (!VYNQO_CALL.call) { VYNQO_CALL.pendingAccepted = data; return; }
    if (data.call.id !== VYNQO_CALL.call.id) return;
    if (VYNQO_CALL.call.status === "ringing") VYNQO_CALL.call.status = "accepted";
    clearTimeout(VYNQO_CALL.ringingTimer);
    showActiveCall(VYNQO_CALL.call, "Starting call...");
    try {
        const callId = VYNQO_CALL.call.id;
        const pc = await ensureCallPeerConnection();
        if (!pc || VYNQO_CALL.call?.id !== callId) return;
        if (VYNQO_CALL.call.direction === "outgoing" && !VYNQO_CALL.offerStarted) {
            VYNQO_CALL.offerStarted = true;
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            VYNQO_CALL.socket.emit("rtc_signal", {
                call_id: VYNQO_CALL.call.id, kind: "offer",
                payload: pc.localDescription.toJSON()
            });
        }
    } catch (error) {
        showToast(error.message);
        await endCurrentCall();
    }
}

async function applyPendingIceCandidates() {
    if (!VYNQO_CALL.pc?.remoteDescription) return;
    const candidates = VYNQO_CALL.pendingIce.splice(0);
    for (const candidate of candidates) {
        try { await VYNQO_CALL.pc.addIceCandidate(candidate); }
        catch (error) { console.warn("Unable to apply queued ICE candidate", error); }
    }
}

async function onRtcSignal(data) {
    if (!VYNQO_CALL.call || data.call_id !== VYNQO_CALL.call.id) return;
    try {
        if (data.kind === "ice" && data.payload && !VYNQO_CALL.pc) {
            VYNQO_CALL.pendingIce.push(data.payload);
            return;
        }
        if (data.kind === "offer") {
            const callId = VYNQO_CALL.call.id;
            const pc = await ensureCallPeerConnection();
            if (!pc || VYNQO_CALL.call?.id !== callId || pc.signalingState !== "stable") return;
            await pc.setRemoteDescription(data.payload);
            await applyPendingIceCandidates();
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            VYNQO_CALL.socket.emit("rtc_signal", {
                call_id: VYNQO_CALL.call.id, kind: "answer",
                payload: pc.localDescription.toJSON()
            });
        } else if (data.kind === "answer") {
            if (!VYNQO_CALL.pc) return;
            await VYNQO_CALL.pc.setRemoteDescription(data.payload);
            await applyPendingIceCandidates();
        } else if (data.kind === "ice" && data.payload) {
            if (VYNQO_CALL.pc?.remoteDescription) await VYNQO_CALL.pc.addIceCandidate(data.payload);
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
    const matchesCurrent = VYNQO_CALL.call && data.call_id === VYNQO_CALL.call.id;
    const matchesIncoming = VYNQO_CALL.incoming && data.call_id === VYNQO_CALL.incoming.id;
    if (!matchesCurrent && !matchesIncoming) {
        // The recipient can accept/decline before the caller's create-call HTTP
        // response reaches the caller. Preserve that terminal event for the race.
        if (VYNQO_CALL.creatingCall && data?.call_id) {
            VYNQO_CALL.pendingEnded.set(data.call_id, data);
        } else {
            refreshCallLogsIfOpen();
        }
        return;
    }
    cleanupCall();
    showToast(data.status === "rejected" ? "Call declined" :
        data.status === "missed" ? "No answer — call missed" :
        data.status === "cancelled" ? "Call cancelled" : "Call ended");
    refreshCallLogsIfOpen();
}
function cleanupCall() {
    clearTimeout(VYNQO_CALL.ringingTimer); clearInterval(VYNQO_CALL.elapsedTimer);
    clearTimeout(VYNQO_CALL.disconnectTimer);
    VYNQO_CALL.stream?.getTracks().forEach(t => t.stop());
    VYNQO_CALL.pc?.close();
    VYNQO_CALL.stream = null; VYNQO_CALL.pc = null; VYNQO_CALL.remoteStream = null;
    VYNQO_CALL.call = null; VYNQO_CALL.incoming = null; VYNQO_CALL.startedAt = null;
    VYNQO_CALL.pendingIce = []; VYNQO_CALL.mediaPromise = null; VYNQO_CALL.offerStarted = false;
    VYNQO_CALL.iceServers = null; VYNQO_CALL.muted = false; VYNQO_CALL.cameraOff = false;
    const muteButton = document.getElementById("vcallMute");
    const cameraButton = document.getElementById("vcallCamera");
    if (muteButton) muteButton.textContent = "Mute";
    if (cameraButton) cameraButton.textContent = "Camera off";
    document.getElementById("vynqoIncomingCall")?.classList.add("hidden");
    document.getElementById("vynqoActiveCall")?.classList.add("hidden");
    const remote = document.getElementById("vcallRemoteVideo"); if (remote) remote.srcObject = null;
    const local = document.getElementById("vcallLocalVideo"); if (local) local.srcObject = null;
    const audio = document.getElementById("vcallRemoteAudio"); if (audio) audio.srcObject = null;
    refreshCallLogsIfOpen();
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


async function loadCallLogs() {
    const container = document.getElementById("callLogsList");
    if (!container) return;
    container.innerHTML = '<div class="empty-state compact"><p>Loading call history…</p></div>';
    try {
        const data = await callApi("/calls/history?limit=100");
        renderCallLogs(data.calls || []);
    } catch (error) {
        container.innerHTML = '<div class="empty-state compact"><h3>Could not load calls</h3><p>Check your connection and try again.</p><button class="pbtn primary" onclick="loadCallLogs()">Try again</button></div>';
    }
}

function renderCallLogs(calls) {
    const container = document.getElementById("callLogsList");
    if (!container) return;
    if (!calls.length) {
        container.innerHTML = '<div class="empty-state"><div class="empty-icon">☎</div><h3>No calls yet</h3><p>Your incoming and outgoing calls will appear here.</p></div>';
        return;
    }
    container.innerHTML = calls.map(call => {
        const person = call.other_user || {};
        const name = callEsc(person.full_name || "Vynqo user");
        const avatar = person.avatar_url
            ? `<img src="${callEsc(person.avatar_url)}" alt="">`
            : `<span>${callEsc(name.charAt(0).toUpperCase())}</span>`;
        const status = call.status === "ended" ? "Completed" :
            call.status === "rejected" ? "Declined" :
            call.status === "missed" ? (call.direction === "incoming" ? "Missed" : "Unanswered") :
            call.status === "cancelled" ? "Cancelled" : callEsc(call.status);
        const direction = call.direction === "incoming" ? "Incoming" : "Outgoing";
        const icon = call.direction === "incoming" ? "↙" : "↗";
        const duration = call.duration_seconds == null ? "" :
            `${Math.floor(call.duration_seconds / 60)}:${String(call.duration_seconds % 60).padStart(2, "0")}`;
        const date = call.created_at ? new Date(call.created_at).toLocaleString() : "";
        return `<article class="call-log-row">
            <div class="call-log-avatar">${avatar}</div>
            <div class="call-log-main">
                <strong>${name}</strong>
                <span class="call-log-meta ${call.status === "missed" || call.status === "rejected" ? "is-missed" : ""}">${icon} ${direction} · ${call.type === "video" ? "Video" : "Audio"} · ${status}${duration ? ` · ${duration}` : ""}</span>
                <small>${callEsc(date)}</small>
            </div>
            <div class="call-log-actions">
                <button type="button" aria-label="Audio call ${name}" title="Audio call" onclick="startVynqoCall(${Number(person.id)}, 'audio')">☎</button>
                <button type="button" aria-label="Video call ${name}" title="Video call" onclick="startVynqoCall(${Number(person.id)}, 'video')">▣</button>
            </div>
        </article>`;
    }).join("");
}

function refreshCallLogsIfOpen() {
    if (document.getElementById("callLogsScreen")?.classList.contains("active")) loadCallLogs();
}

function onCallingAppOpened() { ensureCallUI(); connectVynqoCalling(); }
function onCallingLoggedOut() {
    if (VYNQO_CALL.socket) VYNQO_CALL.socket.disconnect();
    VYNQO_CALL.socket = null; VYNQO_CALL.connected = false; VYNQO_CALL.connectPromise = null; VYNQO_CALL.connectResolve = null; VYNQO_CALL.connectReject = null; VYNQO_CALL.pendingAccepted = null; VYNQO_CALL.pendingEnded.clear(); VYNQO_CALL.creatingCall = false; cleanupCall(); VYNQO_CALL.seen.clear();
}

// Used by friend/message UI without coupling calling to a particular screen.
window.startVynqoCall = startVynqoCall;
