/* Vynqo-wide in-app calling. LiveKit carries audio/video; Flask manages call invitations and history. */

/* Read the same authentication token used by the existing Vynqo login system. */
function callToken() {
    return localStorage.getItem(TOKEN_KEY);
}

const VYNQO_CALL = {
    socket: null, call: null, room: null, localVideoTrack: null,
    incoming: null, ringingTimer: null, elapsedTimer: null, startedAt: null,
    muted: false, cameraOff: false, connected: false, seen: new Set(),
    connectPromise: null, connectResolve: null, connectReject: null, pendingAccepted: null,
    liveKitPromise: null, pendingEnded: new Map(), creatingCall: false
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

let liveKitClientPromise = null;

async function loadLiveKitClient() {
    if (window.LivekitClient) return window.LivekitClient;
    if (!liveKitClientPromise) {
        liveKitClientPromise = new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.src = "https://cdn.jsdelivr.net/npm/livekit-client@2.24.1/dist/livekit-client.umd.min.js";
            script.async = true;
            script.onload = () => window.LivekitClient
                ? resolve(window.LivekitClient)
                : reject(new Error("LiveKit browser SDK did not load."));
            script.onerror = () => reject(new Error("Could not load the LiveKit calling service. Check your internet connection."));
            document.head.appendChild(script);
        }).catch(error => {
            liveKitClientPromise = null;
            throw error;
        });
    }
    return liveKitClientPromise;
}

function attachLiveKitTrack(track) {
    const client = window.LivekitClient;
    if (!track || !client || !VYNQO_CALL.call) return;
    if (track.kind === client.Track.Kind.Video) {
        const video = document.getElementById("vcallRemoteVideo");
        if (VYNQO_CALL.call.type === "video" && video) {
            track.attach(video);
            video.classList.remove("hidden");
            video.play().catch(() => {});
        }
    } else if (track.kind === client.Track.Kind.Audio) {
        const audio = document.getElementById("vcallRemoteAudio");
        if (audio) {
            track.attach(audio);
            audio.play().catch(() => {});
        }
    }
}

async function connectLiveKitCall(callId) {
    if (VYNQO_CALL.room && VYNQO_CALL.call?.id === callId) return VYNQO_CALL.room;
    if (VYNQO_CALL.liveKitPromise) return VYNQO_CALL.liveKitPromise;

    const pending = (async () => {
        const client = await loadLiveKitClient();
        if (VYNQO_CALL.call?.id !== callId) return null;

        const credentials = await callApi(`/calls/${callId}/livekit-token`, "POST");
        if (VYNQO_CALL.call?.id !== callId) return null;
        if (!credentials.server_url || !credentials.participant_token) {
            throw new Error("The server did not return LiveKit connection credentials.");
        }

        const room = new client.Room({ adaptiveStream: true, dynacast: true });
        VYNQO_CALL.room = room;

        room.on(client.RoomEvent.TrackSubscribed, (track) => {
            if (VYNQO_CALL.room !== room) return;
            attachLiveKitTrack(track);
            if (!VYNQO_CALL.startedAt) {
                VYNQO_CALL.startedAt = Date.now();
                document.getElementById("vcallStatus").textContent = "Connected";
                startCallDuration();
            }
        });
        room.on(client.RoomEvent.TrackUnsubscribed, (track) => {
            track.detach();
        });
        room.on(client.RoomEvent.ParticipantConnected, () => {
            if (VYNQO_CALL.room !== room) return;
            if (!VYNQO_CALL.startedAt) {
                VYNQO_CALL.startedAt = Date.now();
                document.getElementById("vcallStatus").textContent = "Connected";
                startCallDuration();
            }
        });
        room.on(client.RoomEvent.Reconnecting, () => {
            const status = document.getElementById("vcallStatus");
            if (status) status.textContent = "Connection interrupted — reconnecting…";
        });
        room.on(client.RoomEvent.Reconnected, () => {
            const status = document.getElementById("vcallStatus");
            if (status) status.textContent = "Connected";
        });
        room.on(client.RoomEvent.Disconnected, () => {
            if (VYNQO_CALL.room !== room || !VYNQO_CALL.call) return;
            showToast("The LiveKit connection was lost");
            endCurrentCall();
        });

        try {
            await room.connect(credentials.server_url, credentials.participant_token);
            if (VYNQO_CALL.call?.id !== callId || VYNQO_CALL.room !== room) {
                await room.disconnect();
                return null;
            }
            await room.localParticipant.setMicrophoneEnabled(true);
            if (VYNQO_CALL.call.type === "video") {
                await room.localParticipant.setCameraEnabled(true);
                const publication = room.localParticipant.getTrackPublication(client.Track.Source.Camera);
                VYNQO_CALL.localVideoTrack = publication?.track || null;
                const localVideo = document.getElementById("vcallLocalVideo");
                if (VYNQO_CALL.localVideoTrack && localVideo) {
                    VYNQO_CALL.localVideoTrack.attach(localVideo);
                    localVideo.classList.remove("hidden");
                    localVideo.play().catch(() => {});
                }
            }
            if (room.remoteParticipants.size > 0 && !VYNQO_CALL.startedAt) {
                VYNQO_CALL.startedAt = Date.now();
                document.getElementById("vcallStatus").textContent = "Connected";
                startCallDuration();
            } else if (VYNQO_CALL.call?.id === callId) {
                document.getElementById("vcallStatus").textContent = "Waiting for the other person…";
            }
            return room;
        } catch (error) {
            if (VYNQO_CALL.room === room) VYNQO_CALL.room = null;
            await room.disconnect().catch(() => {});
            throw error;
        }
    })();

    VYNQO_CALL.liveKitPromise = pending;
    try {
        return await pending;
    } finally {
        if (VYNQO_CALL.liveKitPromise === pending) VYNQO_CALL.liveKitPromise = null;
    }
}

async function onCallAccepted(data) {
    if (!VYNQO_CALL.call) { VYNQO_CALL.pendingAccepted = data; return; }
    if (!data?.call || data.call.id !== VYNQO_CALL.call.id) return;
    if (VYNQO_CALL.call.status === "ringing") VYNQO_CALL.call.status = "accepted";
    clearTimeout(VYNQO_CALL.ringingTimer);
    showActiveCall(VYNQO_CALL.call, "Connecting to LiveKit…");
    try {
        await connectLiveKitCall(VYNQO_CALL.call.id);
    } catch (error) {
        showToast(error.message || "Could not connect this call");
        await endCurrentCall();
    }
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

async function toggleCallMute() {
    const room = VYNQO_CALL.room;
    if (!room) return;
    try {
        VYNQO_CALL.muted = !VYNQO_CALL.muted;
        await room.localParticipant.setMicrophoneEnabled(!VYNQO_CALL.muted);
        document.getElementById("vcallMute").textContent = VYNQO_CALL.muted ? "Unmute" : "Mute";
    } catch (error) {
        VYNQO_CALL.muted = !VYNQO_CALL.muted;
        showToast("Could not change microphone state");
    }
}

async function toggleCallCamera() {
    const room = VYNQO_CALL.room;
    if (!room || VYNQO_CALL.call?.type !== "video") return;
    try {
        VYNQO_CALL.cameraOff = !VYNQO_CALL.cameraOff;
        await room.localParticipant.setCameraEnabled(!VYNQO_CALL.cameraOff);
        document.getElementById("vcallCamera").textContent = VYNQO_CALL.cameraOff ? "Camera on" : "Camera off";
        if (VYNQO_CALL.cameraOff) {
            document.getElementById("vcallLocalVideo").classList.add("hidden");
        } else {
            const client = window.LivekitClient;
            const publication = room.localParticipant.getTrackPublication(client.Track.Source.Camera);
            VYNQO_CALL.localVideoTrack = publication?.track || null;
            const localVideo = document.getElementById("vcallLocalVideo");
            if (VYNQO_CALL.localVideoTrack && localVideo) {
                VYNQO_CALL.localVideoTrack.attach(localVideo);
                localVideo.classList.remove("hidden");
                localVideo.play().catch(() => {});
            }
        }
    } catch (error) {
        VYNQO_CALL.cameraOff = !VYNQO_CALL.cameraOff;
        showToast("Could not change camera state");
    }
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
    clearTimeout(VYNQO_CALL.ringingTimer);
    clearInterval(VYNQO_CALL.elapsedTimer);
    const room = VYNQO_CALL.room;
    VYNQO_CALL.room = null;
    VYNQO_CALL.liveKitPromise = null;
    if (room) room.disconnect().catch(() => {});
    VYNQO_CALL.call = null;
    VYNQO_CALL.incoming = null;
    VYNQO_CALL.startedAt = null;
    VYNQO_CALL.localVideoTrack = null;
    VYNQO_CALL.muted = false;
    VYNQO_CALL.cameraOff = false;
    const muteButton = document.getElementById("vcallMute");
    const cameraButton = document.getElementById("vcallCamera");
    if (muteButton) muteButton.textContent = "Mute";
    if (cameraButton) cameraButton.textContent = "Camera off";
    document.getElementById("vynqoIncomingCall")?.classList.add("hidden");
    document.getElementById("vynqoActiveCall")?.classList.add("hidden");
    const remote = document.getElementById("vcallRemoteVideo"); if (remote) remote.srcObject = null;
    const local = document.getElementById("vcallLocalVideo"); if (local) { local.srcObject = null; local.classList.add("hidden"); }
    const audio = document.getElementById("vcallRemoteAudio"); if (audio) audio.srcObject = null;
    refreshCallLogsIfOpen();
}

async function restoreActiveCall() {
    try {
        const data = await callApi("/calls/active");
        if (!data.call) return;
        if (data.call.status === "ringing" && data.call.direction === "incoming") showIncomingCall(data.call);
        else if (data.call.status === "ringing" && data.call.direction === "outgoing") { VYNQO_CALL.call = data.call; showActiveCall(data.call, "Ringing..."); }
        else if (data.call.status === "accepted") { VYNQO_CALL.call = data.call; showActiveCall(data.call, "Reconnecting..."); await onCallAccepted({call:data.call}); }
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
