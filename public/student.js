(() => {
  // ── Surface any crash on-screen. Without this, a single JS error anywhere
  // in this file (e.g. a missing/renamed element ID) fails completely
  // silently on a phone — the page just looks dead with no way to tell why.
  window.addEventListener("error", (e) => {
    console.error("Uncaught error:", e.error || e.message);
    showFatalError(`Something went wrong loading the page: ${e.message}`);
  });

  function showFatalError(msg) {
    let el = document.getElementById("fatal-error-banner");
    if (!el) {
      el = document.createElement("div");
      el.id = "fatal-error-banner";
      el.style.cssText =
        "position:fixed;top:0;left:0;right:0;z-index:9999;" +
        "background:#7f1d1d;color:#fff;padding:12px 16px;" +
        "font:14px -apple-system,sans-serif;text-align:center;";
      document.body.prepend(el);
    }
    el.textContent = msg + " — please refresh the page.";
  }

  // ── Screens ──────────────────────────────────────────────────────────
  const joinScreen    = document.getElementById("join-screen");
  const waitingScreen = document.getElementById("waiting-screen");
  const liveScreen    = document.getElementById("live-screen");
  const endedScreen   = document.getElementById("ended-screen");

  const joinBtn       = document.getElementById("join-btn");
  const pinInput      = document.getElementById("pin-input");
  const nameInput     = document.getElementById("name-input");
  const joinError     = document.getElementById("join-error");
  const remoteVideo   = document.getElementById("remote-video");
  const fullscreenBtn = document.getElementById("fullscreen-btn");
  const rejoinBtn     = document.getElementById("rejoin-btn");
  const micBtn        = document.getElementById("mic-btn");
  const raiseHandBtn  = document.getElementById("raise-hand-btn");
  const confusedBtn   = document.getElementById("confused-btn");
  const statusBanner  = document.getElementById("status-banner");
  const channelReadout = document.getElementById("channel-readout"); // optional; decorative only
  const confusionOverlay   = document.getElementById("confusion-overlay");
  const confusionBox       = document.getElementById("confusion-box");
  const confusionActions   = document.getElementById("confusion-actions");
  const confusionSendBtn   = document.getElementById("confusion-send-btn");
  const confusionCancelBtn = document.getElementById("confusion-cancel-btn");

  // ── Chat (optional; decorative only — page still works if these are missing) ──
  const chatToggleBtn  = document.getElementById("chat-toggle-btn");
  const chatBadge      = document.getElementById("chat-badge");
  const chatDrawer     = document.getElementById("chat-drawer");
  const chatCloseBtn   = document.getElementById("chat-close-btn");
  const chatMessagesEl = document.getElementById("chat-messages");
  const chatInput      = document.getElementById("chat-input");
  const chatSendBtn    = document.getElementById("chat-send-btn");

  // ── Poll (optional; decorative only — page still works if these are missing) ──
  const pollToggleBtn = document.getElementById("poll-toggle-btn");
  const pollBadge     = document.getElementById("poll-badge");
  const pollDrawer    = document.getElementById("poll-drawer");
  const pollCloseBtn  = document.getElementById("poll-close-btn");
  const pollBodyEl    = document.getElementById("poll-body");

  // ── Camera / video conference (optional; decorative only — page still
  // works if these are missing) ──
  const cameraToggleBtn = document.getElementById("camera-toggle-btn");
  const cameraStrip     = document.getElementById("camera-strip");

  // ── Fail loudly (but not silently-dead) if the HTML and this script are
  // out of sync — e.g. an element was renamed/removed in one file but not
  // the other. Previously a single null here (used later, e.g. at
  // joinBtn.addEventListener) would throw and abort the whole script before
  // ANY button on the page got wired up — Join, Rejoin, Fullscreen, all of
  // it — with zero visible feedback. Now we check up front and report
  // exactly what's missing.
  const required = {
    joinScreen, waitingScreen, liveScreen, endedScreen,
    joinBtn, pinInput, nameInput, joinError,
    remoteVideo, fullscreenBtn, rejoinBtn, micBtn,
    raiseHandBtn, statusBanner,
  };
  const missing = Object.entries(required)
    .filter(([, el]) => !el)
    .map(([name]) => name);
  if (missing.length > 0) {
    showFatalError(`Page failed to load correctly (missing: ${missing.join(", ")})`);
    return; // bail out before wiring up anything that would just throw
  }

  let socket       = null;
  let pc           = null;
  let roomId       = null;
  let micTrack        = null; // local mic MediaStreamTrack, once permission is granted
  let micTransceiver   = null; // the reserved "send our mic to teacher" m-line for the current pc
  let handRaised       = false; // has this student asked to speak?
  let speakAllowed      = false; // has the teacher granted mic permission?
  let bannerTimer       = null;
  let chatOpen          = false;
  let unreadChatCount    = 0;
  let mySocketId        = null; // set once "connect" fires; used to tell "mine" bubbles apart

  // ── Camera (video conference) state ──────────────────────────────────
  let teacherId              = null; // captured from the sender of the FIRST offer we get, which is always the teacher's
  let teacherCameraTransceiver = null; // recvonly m-line (index 3) carrying the teacher's own camera
  let ownCameraTransceiver     = null; // reserved m-line (index 4) we use to send OUR camera to the teacher
  let ownCameraTrack          = null; // our real getUserMedia video track, once captured
  let cameraAllowed          = false; // has the teacher granted this student camera permission?
  let cameraRequested        = false; // have we already asked this session?
  let ownCameraOn            = false;

  // Student-to-student mesh — one PeerConnection per other student in the
  // room, discovered via existing-peers (on join) / peer-joined / peer-left.
  const peerConnections   = new Map(); // studentId -> RTCPeerConnection
  const peerCameraSenders = new Map(); // studentId -> RTCRtpSender for that peer's video m-line
  const peerNames         = new Map(); // studentId -> display name, best-effort

  // Camera tile bookkeeping — kept separate from the tracks themselves
  // because a track can arrive (e.g. the teacher's reserved m-line, or a
  // freshly-negotiated mesh connection) well before that participant has
  // actually turned their camera on. A tile is only ever shown when BOTH a
  // track is known AND the corresponding "camera-state" says it's on.
  const participantTracks = new Map(); // participantId -> MediaStreamTrack
  const participantOn     = new Map(); // participantId -> boolean

  // ── Poll state ──────────────────────────────────────────────────────
  // activePoll is null when no poll has run yet this session; otherwise:
  // { question, options: [{id, text, count, pct}], totalVotes, active, myVote }
  let activePoll   = null;
  let pollOpen     = false;
  let pollSeen     = true; // false right after a poll starts, until the drawer is opened
  let pollSelected = null; // optionId the student has tapped but not yet submitted

  function showBanner(msg, kind) {
    statusBanner.textContent = msg;
    statusBanner.className = "show" + (kind ? " " + kind : "");
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => statusBanner.classList.remove("show"), 4000);
  }

  function setRaiseHandButtonState(raised) {
    handRaised = raised;
    raiseHandBtn.textContent = raised ? "✋ Hand raised" : "✋ Raise hand";
    raiseHandBtn.classList.toggle("hand-active", raised);
  }

  function resetHandAndSpeakState() {
    setRaiseHandButtonState(false);
    speakAllowed = false;
    setMicButtonState(false);
    micBtn.disabled = true;
    micBtn.textContent = "🔒 Mic locked";
  }

  // ── Chat helpers ────────────────────────────────────────────────────
  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function renderChatMessage(msg) {
    if (!chatMessagesEl) return;
    const empty = chatMessagesEl.querySelector(".chat-empty");
    if (empty) empty.remove();

    const mine = msg.senderId === mySocketId;
    const row = document.createElement("div");
    row.className = "chat-msg" + (mine ? " mine" : "") + (msg.role === "teacher" ? " teacher" : "");

    const sender = document.createElement("div");
    sender.className = "chat-sender";
    sender.textContent = mine ? "You" : (msg.senderName || "Student") + (msg.role === "teacher" ? " · Teacher" : "");

    const bubble = document.createElement("div");
    bubble.className = "chat-bubble";
    if (msg.replyTo && msg.replyTo.text) {
      const quote = document.createElement("div");
      quote.className = "chat-reply-quote";
      quote.innerHTML =
        `<span class="chat-reply-name">${escapeHtml(msg.replyTo.senderName || "")}</span>` +
        `<span class="chat-reply-text">${escapeHtml(msg.replyTo.text)}</span>`;
      bubble.appendChild(quote);
    }
    const bodyEl = document.createElement("div");
    bodyEl.innerHTML = escapeHtml(msg.text);
    bubble.appendChild(bodyEl);

    row.appendChild(sender);
    row.appendChild(bubble);
    chatMessagesEl.appendChild(row);
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  }

  function resetChatUI() {
    if (chatMessagesEl) {
      chatMessagesEl.innerHTML = '<div class="chat-empty">No messages yet — say hi 👋</div>';
    }
    unreadChatCount = 0;
    updateChatBadge();
    chatOpen = false;
    if (chatDrawer) chatDrawer.classList.remove("open");
  }

  function updateChatBadge() {
    if (!chatBadge) return;
    if (unreadChatCount > 0) {
      chatBadge.textContent = unreadChatCount > 9 ? "9+" : String(unreadChatCount);
      chatBadge.classList.remove("hidden");
    } else {
      chatBadge.classList.add("hidden");
    }
  }

  function setChatOpen(open) {
    chatOpen = open;
    if (chatDrawer) chatDrawer.classList.toggle("open", open);
    if (open) {
      unreadChatCount = 0;
      updateChatBadge();
      if (chatInput) setTimeout(() => chatInput.focus(), 250);
    }
  }

  function sendChatMessage() {
    if (!chatInput || !socket || !socket.connected || !roomId) return;
    const text = chatInput.value.trim();
    if (!text) return;
    socket.emit("chat-message", { roomId, text });
    chatInput.value = "";
  }

  // ── Poll helpers ─────────────────────────────────────────────────────
  function updatePollBadge() {
    if (!pollBadge) return;
    const showBadge = !!activePoll && activePoll.active && !pollSeen && !pollOpen;
    pollBadge.classList.toggle("hidden", !showBadge);
  }

  function setPollOpen(open) {
    pollOpen = open;
    if (pollDrawer) pollDrawer.classList.toggle("open", open);
    if (open) {
      pollSeen = true;
      updatePollBadge();
    }
  }

  function resetPollUI() {
    activePoll = null;
    pollSelected = null;
    pollSeen = true;
    pollOpen = false;
    if (pollDrawer) pollDrawer.classList.remove("open");
    renderPoll();
  }

  // Renders whichever state applies: no poll yet, still voting (not voted),
  // or results (voted already, or the poll has ended). Fully re-rendered on
  // every update rather than patched incrementally — a poll changes shape
  // rarely enough (once per start/vote/end) that this is simpler and can't
  // drift out of sync with the data.
  function renderPoll() {
    if (!pollBodyEl) return;

    if (!activePoll) {
      pollBodyEl.innerHTML = '<div class="poll-empty">No poll running right now.</div>';
      return;
    }

    const showResults = !activePoll.active || activePoll.myVote != null;

    if (!showResults) {
      const optionsHtml = activePoll.options.map((opt) => {
        const selected = pollSelected === opt.id;
        return (
          `<button type="button" class="poll-option-btn${selected ? " selected" : ""}" data-option-id="${escapeHtml(opt.id)}">` +
            `<span class="opt-dot"></span><span>${escapeHtml(opt.text)}</span>` +
          `</button>`
        );
      }).join("");

      pollBodyEl.innerHTML =
        `<div class="poll-question">${escapeHtml(activePoll.question)}</div>` +
        optionsHtml +
        `<button type="button" id="poll-vote-btn"${pollSelected ? "" : " disabled"}>Submit vote</button>`;

      pollBodyEl.querySelectorAll(".poll-option-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          pollSelected = btn.getAttribute("data-option-id");
          renderPoll();
        });
      });

      const voteBtn = document.getElementById("poll-vote-btn");
      if (voteBtn) voteBtn.addEventListener("click", submitPollVote);
    } else {
      const rowsHtml = activePoll.options.map((opt) => {
        const mine = activePoll.myVote === opt.id;
        return (
          `<div class="poll-result-row">` +
            `<div class="poll-result-top">` +
              `<span class="poll-result-label${mine ? " poll-result-mine" : ""}">${escapeHtml(opt.text)}${mine ? " · Your vote" : ""}</span>` +
              `<span class="poll-result-count">${opt.count} · ${opt.pct}%</span>` +
            `</div>` +
            `<div class="poll-bar-track"><div class="poll-bar-fill" style="width:${opt.pct}%"></div></div>` +
          `</div>`
        );
      }).join("");

      pollBodyEl.innerHTML =
        (!activePoll.active ? '<span class="poll-ended-tag">Poll closed</span>' : "") +
        `<div class="poll-question">${escapeHtml(activePoll.question)}</div>` +
        rowsHtml +
        `<div class="poll-total-votes">${activePoll.totalVotes} vote${activePoll.totalVotes === 1 ? "" : "s"}</div>`;
    }
  }

  function submitPollVote() {
    if (!pollSelected || !socket || !socket.connected || !roomId) return;
    socket.emit("submit-vote", { roomId, optionId: pollSelected });
    // Optimistically mark as voted so results render immediately; the
    // server's "poll-results" broadcast (which includes everyone else's
    // votes too) arrives right behind this and reconciles the counts.
    if (activePoll) activePoll.myVote = pollSelected;
    renderPoll();
  }

  // ── Camera helpers ────────────────────────────────────────────────────

  // A 1x1 black canvas, captured as a MediaStreamTrack. Used to "seal" a
  // reserved video m-line as active (sendonly) the moment a PeerConnection
  // is created, well before the student has camera permission or has
  // turned their camera on. This mirrors the exact bug already hit (and
  // fixed) for the mic m-line: a transceiver with NO track attached when
  // the answer/offer is created negotiates as "a=inactive", and attaching
  // a real track afterward via replaceTrack() does nothing — the line is
  // already sealed. A placeholder track avoids that without requiring an
  // actual camera-permission prompt at join time (unlike the mic fix,
  // which does prompt early — camera access is opt-in via "ask to share"
  // and shouldn't be requested before the teacher has even approved it).
  function createPlaceholderVideoTrack() {
    const canvas = document.createElement("canvas");
    canvas.width = 2;
    canvas.height = 2;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, 2, 2);
    const stream = canvas.captureStream(1); // 1fps is plenty — it's never actually shown
    return stream.getVideoTracks()[0];
  }

  function tileLabel(participantId) {
    if (participantId === "self") return "You";
    if (participantId === teacherId) return "Teacher";
    return peerNames.get(participantId) || "Classmate";
  }

  function removeParticipantTile(participantId) {
    if (cameraStrip) {
      const tile = cameraStrip.querySelector(`[data-pid="${cssEscapeId(participantId)}"]`);
      if (tile) tile.remove();
    }
  }

  // Escapes a socket.id (or "self"/"teacher") for safe use in a CSS
  // attribute selector — ids are opaque strings we don't fully control.
  function cssEscapeId(id) {
    return String(id).replace(/["\\]/g, "\\$&");
  }

  function renderParticipantTile(participantId) {
    const on = !!participantOn.get(participantId);
    const track = participantTracks.get(participantId);

    if (!cameraStrip || !on || !track) {
      removeParticipantTile(participantId);
      return;
    }

    let tile = cameraStrip.querySelector(`[data-pid="${cssEscapeId(participantId)}"]`);
    if (!tile) {
      tile = document.createElement("div");
      tile.className = "cam-tile " + (participantId === "self" ? "cam-tile-self" : "cam-tile-remote");
      tile.dataset.pid = participantId;
      tile.innerHTML = '<video autoplay playsinline muted></video><span class="cam-tile-label"></span>';
      cameraStrip.appendChild(tile);
    }
    const videoEl = tile.querySelector("video");
    // Rebuild the MediaStream only if the underlying track actually
    // changed, so we're not needlessly restarting playback on every
    // unrelated re-render.
    if (!videoEl.srcObject || videoEl.srcObject.getVideoTracks()[0] !== track) {
      videoEl.srcObject = new MediaStream([track]);
      videoEl.play().catch(() => {});
    }
    tile.querySelector(".cam-tile-label").textContent = tileLabel(participantId);
  }

  function setParticipantTrack(participantId, track, name) {
    participantTracks.set(participantId, track);
    if (name) peerNames.set(participantId, name);
    renderParticipantTile(participantId);
  }

  function setParticipantOn(participantId, on) {
    participantOn.set(participantId, on);
    renderParticipantTile(participantId);
  }

  function clearParticipantTile(participantId) {
    participantTracks.delete(participantId);
    participantOn.delete(participantId);
    removeParticipantTile(participantId);
  }

  function setCameraButtonState() {
    if (!cameraToggleBtn) return;
    cameraToggleBtn.classList.toggle("cam-on", ownCameraOn);
    cameraToggleBtn.classList.toggle("cam-requested", cameraRequested && !cameraAllowed);
    cameraToggleBtn.setAttribute(
      "aria-label",
      !cameraAllowed ? (cameraRequested ? "Camera request pending" : "Ask to share camera")
                     : (ownCameraOn ? "Turn camera off" : "Turn camera on")
    );
  }

  // Tapping the camera icon either (a) sends the one-time request to the
  // teacher if we don't have permission yet, or (b) flips our own camera
  // on/off once we do.
  async function toggleOwnCamera() {
    if (!socket || !socket.connected || !roomId) return;

    if (!cameraAllowed) {
      if (!cameraRequested) {
        socket.emit("request-camera", { roomId });
        cameraRequested = true;
        showBanner("📷 Camera request sent — waiting for the teacher.");
        setCameraButtonState();
      } else {
        showBanner("📷 Still waiting for the teacher to allow your camera.");
      }
      return;
    }

    if (!ownCameraOn) {
      if (!ownCameraTrack) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: "user", width: { ideal: 320 }, height: { ideal: 240 } },
          });
          ownCameraTrack = stream.getVideoTracks()[0];
        } catch (e) {
          logToTeacher("Could not access camera", e);
          showBanner("⚠️ Could not access your camera.");
          return;
        }
      }

      // Swap the placeholder (or a stale track, on rejoin) for the real
      // camera on every m-line that's carrying our video — the reserved
      // slot to the teacher, and every open mesh connection to a classmate.
      if (ownCameraTransceiver) {
        await ownCameraTransceiver.sender.replaceTrack(ownCameraTrack);
        ownCameraTransceiver.direction = "sendonly";
      }
      peerCameraSenders.forEach((sender) => {
        sender.replaceTrack(ownCameraTrack).catch((e) => logToTeacher("replaceTrack to peer failed", e));
      });

      ownCameraTrack.enabled = true;
      ownCameraOn = true;
      socket.emit("camera-state", { roomId, on: true });
      setParticipantTrack("self", ownCameraTrack, "You");
      setParticipantOn("self", true);
    } else {
      ownCameraTrack.enabled = false;
      ownCameraOn = false;
      socket.emit("camera-state", { roomId, on: false });
      setParticipantOn("self", false);
    }
    setCameraButtonState();
  }

  // ── Student-to-student mesh ──────────────────────────────────────────
  // One direct PeerConnection per other student, carrying just a single
  // video m-line each way for camera tiles (mic/screen only ever flow
  // through the teacher). The newcomer always initiates: on join we're
  // handed the roster of who's already here (existing-peers) and offer to
  // each of them; everyone already in the room just gets told a peer
  // joined and waits for that incoming offer.
  function createPeerConnectionTo(peerId, peerName, isInitiator) {
    if (peerConnections.has(peerId)) return peerConnections.get(peerId);
    if (peerName) peerNames.set(peerId, peerName);

    const ppc = new RTCPeerConnection(RTC_CONFIG);
    peerConnections.set(peerId, ppc);

    ppc.onicecandidate = (event) => {
      if (!event.candidate) return;
      socket.emit("ice-candidate", {
        targetId: peerId,
        roomId,
        candidate: {
          candidate:     event.candidate.candidate,
          sdpMid:        event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
        },
      });
    };

    ppc.ontrack = (event) => {
      if (event.track.kind !== "video") return;
      setParticipantTrack(peerId, event.track, peerNames.get(peerId));
    };

    ppc.onconnectionstatechange = () => {
      if (ppc.connectionState === "failed" || ppc.connectionState === "closed") {
        closePeerConnection(peerId);
      }
    };

    // Single sendrecv video m-line, sealed immediately with a placeholder
    // (see createPlaceholderVideoTrack) so it's already active if/when we
    // turn our camera on later — no renegotiation needed either direction.
    const transceiver = ppc.addTransceiver("video", { direction: "sendrecv" });
    peerCameraSenders.set(peerId, transceiver.sender);
    transceiver.sender.replaceTrack(ownCameraTrack || createPlaceholderVideoTrack());

    if (isInitiator) {
      ppc.createOffer()
        .then((offer) => ppc.setLocalDescription(offer).then(() => offer))
        .then((offer) => {
          socket.emit("offer", { targetId: peerId, roomId, sdp: { type: offer.type, sdp: offer.sdp } });
        })
        .catch((e) => logToTeacher("Failed to offer peer", peerId, e));
    }

    return ppc;
  }

  async function handlePeerOffer(peerId, sdpData) {
    const ppc = createPeerConnectionTo(peerId, peerNames.get(peerId), false);
    try {
      await ppc.setRemoteDescription(new RTCSessionDescription({ type: "offer", sdp: sdpData.sdp }));
      const answer = await ppc.createAnswer();
      await ppc.setLocalDescription(answer);
      socket.emit("answer", { targetId: peerId, roomId, sdp: { type: answer.type, sdp: answer.sdp } });
    } catch (e) {
      logToTeacher("Failed to answer peer offer from", peerId, e);
    }
  }

  function closePeerConnection(peerId) {
    const ppc = peerConnections.get(peerId);
    if (ppc) {
      try { ppc.close(); } catch (e) { /* already closed */ }
    }
    peerConnections.delete(peerId);
    peerCameraSenders.delete(peerId);
    peerNames.delete(peerId);
    clearParticipantTile(peerId);
  }

  function closeAllPeerConnections() {
    Array.from(peerConnections.keys()).forEach(closePeerConnection);
  }

  // ── Relay console logs to the teacher's app via the signaling server,
  // so they show up directly in Android Studio's Logcat (tag:LiveClassManager)
  // without needing chrome://inspect USB debugging on the student's phone.
  function logToTeacher(...args) {
    const message = args.map(a => {
      if (a instanceof Error) return a.message || String(a);
      return typeof a === "string" ? a : JSON.stringify(a);
    }).join(" ");
    console.log(...args);
    if (socket && socket.connected && roomId) {
      socket.emit("client-log", { roomId, message });
    }
  }

  const RTC_CONFIG = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      // TURN (Metered.ca relay) — required for mobile-data / CGNAT / symmetric
      // NAT networks where a direct STUN-only path can't be established.
      { urls: "stun:stun.relay.metered.ca:80" },
      {
        urls: "turn:global.relay.metered.ca:80",
        username: "e93bee4c347d0e117a51a185",
        credential: "6klB8AQpfbNOJZcq",
      },
      {
        urls: "turn:global.relay.metered.ca:80?transport=tcp",
        username: "e93bee4c347d0e117a51a185",
        credential: "6klB8AQpfbNOJZcq",
      },
      {
        urls: "turn:global.relay.metered.ca:443",
        username: "e93bee4c347d0e117a51a185",
        credential: "6klB8AQpfbNOJZcq",
      },
      {
        urls: "turns:global.relay.metered.ca:443?transport=tcp",
        username: "e93bee4c347d0e117a51a185",
        credential: "6klB8AQpfbNOJZcq",
      },
    ],
  };

  // ── Helpers ──────────────────────────────────────────────────────────
  function show(screen) {
    [joinScreen, waitingScreen, liveScreen, endedScreen].forEach((s) =>
      s.classList.add("hidden")
    );
    screen.classList.remove("hidden");
  }

  function showError(msg) {
    joinError.textContent = msg;
    joinError.classList.remove("hidden");
  }

  function clearError() {
    joinError.classList.add("hidden");
  }

  function getServerUrl() {
    return window.location.origin;
  }

  // ── Connect ───────────────────────────────────────────────────────────
  function connect() {
    clearError();

    if (typeof io === "undefined") {
      showError("Live chat failed to load. Please refresh the page and try again.");
      return;
    }

    roomId = pinInput.value.trim().toUpperCase();
    if (!roomId) {
      showError("Please enter the room code.");
      return;
    }

    if (socket) socket.disconnect();

    if (channelReadout) channelReadout.textContent = "CH · " + roomId;

    resetHandAndSpeakState();
    resetChatUI();
    resetPollUI();
    resetCameraState();
    show(waitingScreen);

    const waitingSubtitle = waitingScreen.querySelector(".subtitle");
    const slowConnectTimer = setTimeout(() => {
      if (waitingSubtitle) {
        waitingSubtitle.textContent =
          "Still connecting — the server may be waking up, this can take up to a minute…";
      }
    }, 8000);

    socket = io(getServerUrl(), { transports: ["websocket", "polling"] });

    let hasJoinedOnce = false; // guards against the "two students" bug below

    socket.on("connect", () => {
      clearTimeout(slowConnectTimer);
      mySocketId = socket.id;
      logToTeacher("✅ Connected to signaling server");

      // BUG FIX: Socket.IO's "connect" event fires on every reconnect too,
      // not just the first connection — including silent automatic
      // reconnects after a brief network blip. Each reconnect gets a NEW
      // socket.id, and the server uses socket.id as the student's identity.
      // If we blindly re-emit "join-room" here every time, one real
      // student who has a momentary Wi-Fi hiccup shows up as a SECOND
      // student on the teacher's roster. Only auto-join on the very first
      // connect; treat any later reconnect as "connection lost", matching
      // the manual rejoin flow instead of silently duplicating the join.
      if (!hasJoinedOnce) {
        hasJoinedOnce = true;
        socket.emit("join-room", { roomId, name: nameInput.value.trim() });
      } else {
        logToTeacher("Reconnected after a drop — not auto-rejoining to avoid a duplicate roster entry.");
        cleanupPeerConnection();
        show(joinScreen);
        showError("Connection was lost. Please rejoin the class.");
      }
    });

    socket.on("connect_error", (err) => {
      clearTimeout(slowConnectTimer);
      logToTeacher("Connection error:", err);
      show(joinScreen);
      showError("Could not reach the server. Check your internet connection.");
    });

    socket.on("join-success", (data) => {
      logToTeacher("✅ Joined room:", data.roomId);
      if (Array.isArray(data.chatHistory) && data.chatHistory.length) {
        if (chatMessagesEl) chatMessagesEl.innerHTML = "";
        data.chatHistory.forEach(renderChatMessage);
      }
      if (data.poll) {
        activePoll = data.poll;
        pollSeen = !activePoll.active; // don't badge a poll that's already closed
        renderPoll();
        updatePollBadge();
      }
    });

    socket.on("chat-message", (msg) => {
      renderChatMessage(msg);
      if (msg.senderId !== mySocketId && !chatOpen) {
        unreadChatCount++;
        updateChatBadge();
      }
    });

    // ── Poll ──────────────────────────────────────────────────────────
    socket.on("poll-started", (data) => {
      logToTeacher("📊 Poll started:", data.question);
      activePoll = {
        question: data.question,
        options: (data.options || []).map((o) => ({ ...o, count: 0, pct: 0 })),
        totalVotes: 0,
        active: true,
        myVote: null,
      };
      pollSelected = null;
      pollSeen = false;
      renderPoll();
      updatePollBadge();
      if (!pollOpen) showBanner("📊 A new poll just started — tap the poll icon to vote.");
    });

    socket.on("poll-results", (results) => {
      if (!results) return;
      const myVote = activePoll ? activePoll.myVote : null;
      activePoll = { ...results, myVote };
      renderPoll();
    });

    socket.on("poll-ended", (results) => {
      if (!results) return;
      logToTeacher("📊 Poll ended:", results.question);
      const myVote = activePoll ? activePoll.myVote : null;
      activePoll = { ...results, active: false, myVote };
      renderPoll();
    });

    socket.on("join-error", (data) => {
      show(joinScreen);
      showError(data.message || "Unable to join room.");
    });

    socket.on("room-ended", () => {
      logToTeacher("❌ Room ended by teacher");
      cleanupPeerConnection();
      show(endedScreen);
    });

    // ── Teacher granted this student permission to speak. Unlock the mic
    // button (still starts muted — the student must tap it themselves) and
    // clear the raised-hand indicator since the request has been answered.
    socket.on("speak-allowed", () => {
      logToTeacher("🎤 Teacher allowed you to speak");
      speakAllowed = true;
      micBtn.disabled = false;
      setMicButtonState(false);
      setRaiseHandButtonState(false);
      showBanner("🎤 The teacher allowed you to speak — tap the mic to unmute.", "granted");
    });

    // ── Teacher revoked mic permission (or it was never granted). Force the
    // mic off immediately and lock the button again.
    socket.on("speak-muted", () => {
      logToTeacher("🔇 Teacher turned off your mic access");
      speakAllowed = false;
      if (micTrack) micTrack.enabled = false;
      setMicButtonState(false);
      micBtn.disabled = true;
      micBtn.textContent = "🔒 Mic locked";
      showBanner("🔇 The teacher turned off your mic access.", "revoked");
    });

    // ── Camera permission (mirrors speak-allowed/speak-muted above) ────
    socket.on("camera-allowed", () => {
      logToTeacher("🎥 Teacher allowed your camera");
      cameraAllowed = true;
      setCameraButtonState();
      showBanner("🎥 The teacher allowed your camera — tap it to turn on.", "granted");
    });

    socket.on("camera-revoked", () => {
      logToTeacher("🚫 Teacher turned off your camera access");
      cameraAllowed = false;
      cameraRequested = false;
      if (ownCameraTrack) ownCameraTrack.enabled = false;
      ownCameraOn = false;
      setParticipantOn("self", false);
      setCameraButtonState();
      showBanner("🚫 The teacher turned off your camera access.", "revoked");
    });

    // Broadcast whenever ANY participant's camera (teacher, us, or a
    // classmate) turns on/off — just the "is it worth rendering" signal;
    // the actual frames travel over whichever PeerConnection already
    // carries that participant's track.
    socket.on("camera-state", ({ participantId, on }) => {
      if (participantId === mySocketId) return; // our own toggle already updates locally
      setParticipantOn(participantId, on);
    });

    // ── Student-to-student mesh discovery ───────────────────────────────
    socket.on("existing-peers", ({ peers }) => {
      (peers || []).forEach((p) => createPeerConnectionTo(p.studentId, p.name, true));
    });

    socket.on("peer-joined", ({ studentId, name }) => {
      if (name) peerNames.set(studentId, name);
      // No PeerConnection created yet — we wait for their incoming offer
      // (routed below) rather than racing to create one ourselves.
    });

    socket.on("peer-left", ({ studentId }) => {
      closePeerConnection(studentId);
    });

    // The very first offer we ever receive is always from the teacher
    // (sent immediately on join, ahead of any mesh negotiation). Every
    // subsequent offer with a different sender is a classmate's mesh offer.
    socket.on("offer", async (data) => {
      if (teacherId === null || data.senderId === teacherId) {
        teacherId = data.senderId;
        logToTeacher("📨 Offer received (teacher)");
        await handleOffer(data.senderId, data.roomId, data.sdp);
      } else {
        logToTeacher("📨 Offer received (peer)", data.senderId);
        await handlePeerOffer(data.senderId, data.sdp);
      }
    });

    // Answers only ever come back from a classmate we offered to first —
    // the teacher connection is answered by US, never the other way round.
    socket.on("answer", async (data) => {
      const ppc = peerConnections.get(data.senderId);
      if (!ppc) return;
      try {
        await ppc.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp: data.sdp.sdp }));
      } catch (e) {
        logToTeacher("Failed to set remote answer from peer", data.senderId, e);
      }
    });

    socket.on("ice-candidate", async (data) => {
      const targetPc = data.senderId === teacherId ? pc : peerConnections.get(data.senderId);
      if (!targetPc) return;
      try {
        await targetPc.addIceCandidate(new RTCIceCandidate({
          candidate:     data.candidate.candidate,
          sdpMid:        data.candidate.sdpMid,
          sdpMLineIndex: data.candidate.sdpMLineIndex,
        }));
      } catch (e) {
        logToTeacher("Failed to add ICE candidate", e);
      }
    });

    socket.on("disconnect", () => {
      console.log("❌ Socket disconnected");
    });
  }

  // ── WebRTC ────────────────────────────────────────────────────────────
  async function handleOffer(teacherIdArg, roomIdArg, sdpData) {
    if (pc) pc.close();
    pc = new RTCPeerConnection(RTC_CONFIG);

    // The teacher's screen video, teacher audio, AND the teacher's own
    // camera all share the same stream label ("live-stream") on the wire,
    // so event.streams[0] alone can't tell them apart — a MediaStream with
    // two video tracks in it renders ambiguously (browsers pick one, not
    // necessarily the one we want). Instead we identify each incoming
    // track by its transceiver's position, which is fixed by the order
    // LiveClassManager.kt adds them in: [0]=screen video, [1]=teacher
    // audio, [2]=our mic (send-only, no incoming track), [3]=teacher
    // camera, [4]=our camera (send-only, no incoming track). Screen video
    // and teacher audio are combined into one manually-built stream for
    // the main <video>; the teacher's camera gets its own tile.
    let mainStream = null;
    pc.ontrack = (event) => {
      const transceivers = pc.getTransceivers();
      const idx = transceivers.indexOf(event.transceiver);

      if (idx === 3) {
        logToTeacher("🎥 Teacher camera track received");
        setParticipantTrack(teacherIdArg, event.track, "Teacher");
        return;
      }

      logToTeacher("🎥 Remote stream track received:", event.track.kind);
      if (!mainStream) mainStream = new MediaStream();
      mainStream.addTrack(event.track);
      remoteVideo.srcObject = mainStream;
      if (event.track.kind === "video") {
        remoteVideo.play().catch(console.error);
        show(liveScreen);
      }
    };

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      socket.emit("ice-candidate", {
        targetId: teacherIdArg,
        roomId:   roomIdArg,
        candidate: {
          candidate:     event.candidate.candidate,
          sdpMid:        event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
        },
      });
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") {
        show(joinScreen);
        showError("Connection to the teacher failed. Please rejoin.");
        cleanupPeerConnection();
      }
    };

    try {
      await pc.setRemoteDescription(
        new RTCSessionDescription({ type: "offer", sdp: sdpData.sdp })
      );

      // The teacher's offer reserves a 3rd m-line (after screen-video and
      // teacher-audio) specifically to receive OUR mic. It arrives here as
      // an existing transceiver with direction "sendonly" already negotiated
      // (recvonly on the teacher's side, mirrored). We just need to attach
      // our mic track to its sender — no extra offer/answer round trip
      // needed since the m-line already exists in this very answer.
      const transceivers = pc.getTransceivers();
      logToTeacher(
        "Transceivers after offer:",
        transceivers.map((t, i) => `[${i}] ${t.receiver.track?.kind} dir=${t.direction} mid=${t.mid}`).join(", ")
      );
      micTransceiver = transceivers[2] || null;
      teacherCameraTransceiver = transceivers[3] || null;
      ownCameraTransceiver = transceivers[4] || null;

      // Seal our camera m-line as active right away with a placeholder
      // track (see createPlaceholderVideoTrack for why) — no camera
      // permission prompt happens here, just a synthetic black frame, so
      // this costs nothing UX-wise even for students who never touch the
      // camera feature this session.
      if (ownCameraTransceiver) {
        try {
          await ownCameraTransceiver.sender.replaceTrack(ownCameraTrack || createPlaceholderVideoTrack());
          ownCameraTransceiver.direction = "sendonly";
          logToTeacher("Camera m-line pre-sealed. mid:", ownCameraTransceiver.mid);
        } catch (e) {
          logToTeacher("Failed to pre-seal camera m-line", e);
          ownCameraTransceiver = null;
        }
      }

      // BUG FIX: previously we only requested the mic + attached it the
      // FIRST time the student tapped "Mic on" — which happens well after
      // this answer is created. With no track attached at answer-creation
      // time, the browser negotiates this m-line as "a=inactive" instead
      // of "a=sendonly" — meaning no RTP session is ever set up for it at
      // all. Attaching a track afterward via replaceTrack() then does
      // nothing, because the line was already sealed inactive in the
      // original handshake. That's why the teacher never heard anything,
      // with no errors anywhere.
      //
      // Fix: grab the mic now (before createAnswer), keep it muted
      // (`enabled = false`) by default, and let the mic button just flip
      // `.enabled` — no renegotiation needed either way. This does mean a
      // mic-permission prompt appears as soon as the student joins, not
      // when they first tap the button — an intentional trade-off for
      // reliability. If permission is denied, we degrade gracefully:
      // video/audio-from-teacher still works fine, only the student's own
      // mic feature is unavailable for that session.
      if (micTransceiver && !micTrack) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          micTrack = stream.getAudioTracks()[0];
          micTrack.enabled = false; // muted until the student taps the button
          await micTransceiver.sender.replaceTrack(micTrack);
          // replaceTrack() ONLY swaps which track the sender uses — it does
          // NOT change the transceiver's negotiated direction. Any
          // transceiver created while processing an incoming offer defaults
          // to "recvonly" regardless of what the offer said, and stays that
          // way until explicitly changed. Without this line, createAnswer()
          // still sees "recvonly" on our side for this m-line, which
          // combines with the teacher's "recvonly" (they only want to
          // receive here) into "inactive" — nothing can flow either way.
          // This was the actual root cause of the teacher never hearing
          // students, even after pre-attaching the track.
          micTransceiver.direction = "sendonly";
          logToTeacher("Mic pre-attached (muted). mid:", micTransceiver.mid, "direction now:", micTransceiver.direction);
        } catch (e) {
          logToTeacher("Mic permission not granted at join time — mic feature unavailable this session.", e);
          micTransceiver = null;
        }
      } else if (micTransceiver && micTrack) {
        // Rejoining/renegotiated: re-attach whatever mic track we already have.
        await micTransceiver.sender.replaceTrack(micTrack);
        micTransceiver.direction = "sendonly";
      } else {
        logToTeacher("No reserved audio-return transceiver found — mic feature unavailable this session.");
      }

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      // DEBUG: confirm the answer we're about to send actually negotiates
      // the 3rd (mic-return) line as active, not "a=inactive".
      const answerMLines = answer.sdp.split("\n")
        .filter(l => l.startsWith("m=") || l.startsWith("a=sendrecv") ||
                     l.startsWith("a=sendonly") || l.startsWith("a=recvonly") ||
                     l.startsWith("a=inactive"));
      logToTeacher("Answer m-lines:", answerMLines.join(" | "));

      socket.emit("answer", {
        targetId: teacherIdArg,
        roomId:   roomIdArg,
        sdp: { type: answer.type, sdp: answer.sdp },
      });
      logToTeacher("✅ Answer sent");
    } catch (e) {
      logToTeacher("handleOffer failed", e);
      show(joinScreen);
      showError("Failed to connect. Please try again.");
    }
  }

  function cleanupPeerConnection() {
    if (pc) { pc.close(); pc = null; }
    if (remoteVideo) { remoteVideo.pause(); remoteVideo.srcObject = null; }
    micTransceiver = null;
    teacherCameraTransceiver = null;
    ownCameraTransceiver = null;
    teacherId = null;
    resetHandAndSpeakState();
    resetCameraState();
    closeAllPeerConnections();
    if (typeof exitConfusionMode === "function" && confusionActive) exitConfusionMode();
  }

  // Resets everything camera-related for a fresh join/rejoin. Deliberately
  // does NOT dispose ownCameraTrack — if the student already granted camera
  // permission once this page load, there's no reason to make the browser
  // ask again on a reconnect; it just gets re-attached (still muted) the
  // next time a PeerConnection is set up.
  function resetCameraState() {
    cameraAllowed = false;
    cameraRequested = false;
    ownCameraOn = false;
    if (ownCameraTrack) ownCameraTrack.enabled = false;
    participantTracks.clear();
    participantOn.clear();
    if (cameraStrip) cameraStrip.innerHTML = "";
    setCameraButtonState();
  }

  function setMicButtonState(on) {
    micBtn.textContent = on ? "🎤 Mic on" : "🔇 Mic off";
    micBtn.classList.toggle("mic-on", on);
  }

  async function toggleMic() {
    if (!speakAllowed) {
      showBanner("✋ Raise your hand and wait for the teacher to allow you to speak.");
      return;
    }

    if (!micTransceiver || !micTrack) {
      // Either the reserved line wasn't available, or mic permission was
      // denied when the student joined. Give them one more chance to grant
      // it now, in case they said no by mistake the first time.
      if (micTransceiver && !micTrack) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          micTrack = stream.getAudioTracks()[0];
          micTrack.enabled = true;
          await micTransceiver.sender.replaceTrack(micTrack);
          micTransceiver.direction = "sendonly";
          setMicButtonState(true);
          return;
        } catch (e) {
          logToTeacher("Could not access microphone", e);
        }
      }
      const original = micBtn.textContent;
      micBtn.textContent = "⚠️ Mic unavailable";
      setTimeout(() => { micBtn.textContent = original; }, 2500);
      return;
    }

    const turningOn = !micTrack.enabled;
    micTrack.enabled = turningOn;
    setMicButtonState(turningOn);
  }

  // ── "Confused" area select ──────────────────────────────────────────
  // Drag directly over the mirrored teacher screen to mark exactly where
  // you're confused, instead of a blind tap that only records *when*. The
  // drag rectangle is converted to coordinates normalized (0..1) to the
  // actual VIDEO CONTENT area — not the raw viewport — which is what makes
  // this land accurately on the teacher's side: <video> uses
  // object-fit:contain, so depending on the student's screen aspect ratio
  // there can be black letterbox bars above/below or left/right of the
  // picture. Normalizing to the rendered picture (not the element box)
  // means the same relative spot lands in the same place on the teacher's
  // canvas regardless of the student's device shape.
  let confusionActive = false;
  let dragStart = null;    // {x, y} in viewport px, where the drag began
  let dragLastRect = null; // last on-screen box rect (viewport px), for sending

  function getVideoContentRect() {
    const rect = remoteVideo.getBoundingClientRect();
    const vw = remoteVideo.videoWidth;
    const vh = remoteVideo.videoHeight;
    if (!vw || !vh) return rect; // no frame yet — fall back to full element

    const elementRatio = rect.width / rect.height;
    const videoRatio = vw / vh;

    let contentWidth, contentHeight, offsetX, offsetY;
    if (videoRatio > elementRatio) {
      contentWidth = rect.width;
      contentHeight = rect.width / videoRatio;
      offsetX = 0;
      offsetY = (rect.height - contentHeight) / 2;
    } else {
      contentHeight = rect.height;
      contentWidth = rect.height * videoRatio;
      offsetY = 0;
      offsetX = (rect.width - contentWidth) / 2;
    }
    return {
      left: rect.left + offsetX,
      top: rect.top + offsetY,
      width: contentWidth,
      height: contentHeight,
    };
  }

  function toNormalized(clientX, clientY, contentRect) {
    const x = (clientX - contentRect.left) / contentRect.width;
    const y = (clientY - contentRect.top) / contentRect.height;
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
  }

  const MIN_BOX_FRACTION = 0.05; // a bare tap still marks a visible, sendable area

  function enterConfusionMode() {
    if (!confusionOverlay) return;
    confusionActive = true;
    dragStart = null;
    dragLastRect = null;
    confusionBox.classList.remove("show");
    confusionActions.classList.remove("show");
    confusionOverlay.classList.add("active");
    confusedBtn.classList.add("confused-active");
  }

  function exitConfusionMode() {
    if (!confusionOverlay) return;
    confusionActive = false;
    dragStart = null;
    dragLastRect = null;
    confusionOverlay.classList.remove("active");
    confusionBox.classList.remove("show");
    confusionActions.classList.remove("show");
    confusedBtn.classList.remove("confused-active");
  }

  function updateBoxFromDrag(clientX, clientY) {
    const contentRect = getVideoContentRect();
    const x1 = Math.min(dragStart.x, clientX);
    const y1 = Math.min(dragStart.y, clientY);
    let x2 = Math.max(dragStart.x, clientX);
    let y2 = Math.max(dragStart.y, clientY);

    const minSide = contentRect.width * MIN_BOX_FRACTION;
    if (x2 - x1 < minSide) {
      const cx = (x1 + x2) / 2;
      x2 = cx + minSide / 2;
    }
    if (y2 - y1 < minSide) {
      const cy = (y1 + y2) / 2;
      y2 = cy + minSide / 2;
    }

    const rect = { left: x1, top: y1, width: x2 - x1, height: y2 - y1 };
    dragLastRect = rect;

    confusionBox.style.left   = rect.left + "px";
    confusionBox.style.top    = rect.top + "px";
    confusionBox.style.width  = rect.width + "px";
    confusionBox.style.height = rect.height + "px";
    confusionBox.classList.add("show");
  }

  if (confusionOverlay) {
    confusionOverlay.addEventListener("pointerdown", (e) => {
      dragStart = { x: e.clientX, y: e.clientY };
      confusionActions.classList.remove("show");
      updateBoxFromDrag(e.clientX, e.clientY);
    });

    confusionOverlay.addEventListener("pointermove", (e) => {
      if (!dragStart) return;
      updateBoxFromDrag(e.clientX, e.clientY);
    });

    confusionOverlay.addEventListener("pointerup", (e) => {
      if (!dragStart) return;
      updateBoxFromDrag(e.clientX, e.clientY);
      dragStart = null;
      confusionActions.classList.add("show");
    });

    confusionCancelBtn.addEventListener("click", exitConfusionMode);

    confusionSendBtn.addEventListener("click", () => {
      if (!dragLastRect || !socket || !socket.connected || !roomId) {
        exitConfusionMode();
        return;
      }
      const contentRect = getVideoContentRect();
      const topLeft = toNormalized(dragLastRect.left, dragLastRect.top, contentRect);
      const bottomRight = toNormalized(
        dragLastRect.left + dragLastRect.width,
        dragLastRect.top + dragLastRect.height,
        contentRect
      );

      socket.emit("mark-confused", {
        roomId,
        x: topLeft.x,
        y: topLeft.y,
        w: Math.max(0.01, bottomRight.x - topLeft.x),
        h: Math.max(0.01, bottomRight.y - topLeft.y),
      });

      showBanner("😵 Marked — the teacher can see exactly where.");
      exitConfusionMode();

      confusedBtn.classList.add("confused-flash");
      confusedCooldown = true;
      setTimeout(() => {
        confusedBtn.classList.remove("confused-flash");
        confusedCooldown = false;
      }, 3000);
    });
  }

  // ── Auto-fill room code from URL ?room=ROOMCODE ───────────────────────
  const urlParams = new URLSearchParams(window.location.search);
  const roomParam = urlParams.get("room");
  if (roomParam) pinInput.value = roomParam.toUpperCase();

  // ── Event listeners ───────────────────────────────────────────────────
  joinBtn.addEventListener("click", connect);
  pinInput.addEventListener("keydown",  (e) => { if (e.key === "Enter") connect(); });
  nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") connect(); });

  rejoinBtn.addEventListener("click", () => {
    show(joinScreen);
    pinInput.value = "";
  });

  micBtn.addEventListener("click", toggleMic);

  // Confused button opens the drag-to-select overlay (see above) instead of
  // firing blind — the whole point is telling the teacher exactly WHERE,
  // not just that a tap happened. A short cooldown after sending stops a
  // nervous double-tap from spamming duplicate signals for the same moment.
  let confusedCooldown = false;
  if (confusedBtn) {
    confusedBtn.addEventListener("click", () => {
      if (!socket || !socket.connected || !roomId) return;
      if (confusedCooldown) return;
      if (confusionActive) { exitConfusionMode(); return; }
      enterConfusionMode();
    });
  }

  raiseHandBtn.addEventListener("click", () => {
    if (!socket || !socket.connected || !roomId) return;
    if (handRaised) {
      socket.emit("lower-hand", { roomId });
      setRaiseHandButtonState(false);
    } else {
      socket.emit("raise-hand", { roomId });
      setRaiseHandButtonState(true);
      showBanner("✋ Hand raised — waiting for the teacher.");
    }
  });

  // Mic starts locked every page load until the teacher grants permission.
  micBtn.disabled = true;

  if (chatToggleBtn) chatToggleBtn.addEventListener("click", () => setChatOpen(!chatOpen));
  if (chatCloseBtn) chatCloseBtn.addEventListener("click", () => setChatOpen(false));
  if (chatSendBtn) chatSendBtn.addEventListener("click", sendChatMessage);
  if (chatInput) chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendChatMessage();
  });

  if (pollToggleBtn) pollToggleBtn.addEventListener("click", () => setPollOpen(!pollOpen));
  if (pollCloseBtn) pollCloseBtn.addEventListener("click", () => setPollOpen(false));

  if (cameraToggleBtn) cameraToggleBtn.addEventListener("click", toggleOwnCamera);
  setCameraButtonState();

  fullscreenBtn.addEventListener("click", () => {
    if (remoteVideo.requestFullscreen) remoteVideo.requestFullscreen();
    else if (remoteVideo.webkitRequestFullscreen) remoteVideo.webkitRequestFullscreen();
  });
})();