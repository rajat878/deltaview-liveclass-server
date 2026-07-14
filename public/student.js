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
  const statusBanner  = document.getElementById("status-banner");
  const channelReadout = document.getElementById("channel-readout"); // optional; decorative only

  // ── Chat (optional; decorative only — page still works if these are missing) ──
  const chatToggleBtn  = document.getElementById("chat-toggle-btn");
  const chatBadge      = document.getElementById("chat-badge");
  const chatDrawer     = document.getElementById("chat-drawer");
  const chatCloseBtn   = document.getElementById("chat-close-btn");
  const chatMessagesEl = document.getElementById("chat-messages");
  const chatInput      = document.getElementById("chat-input");
  const chatSendBtn    = document.getElementById("chat-send-btn");

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
    });

    socket.on("chat-message", (msg) => {
      renderChatMessage(msg);
      if (msg.senderId !== mySocketId && !chatOpen) {
        unreadChatCount++;
        updateChatBadge();
      }
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

    socket.on("offer", async (data) => {
      logToTeacher("📨 Offer received");
      await handleOffer(data.senderId, data.roomId, data.sdp);
    });

    socket.on("ice-candidate", async (data) => {
      if (!pc) return;
      try {
        await pc.addIceCandidate(new RTCIceCandidate({
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

    pc.ontrack = (event) => {
      logToTeacher("🎥 Remote stream received");
      remoteVideo.srcObject = event.streams[0];
      remoteVideo.play().catch(console.error);
      show(liveScreen);
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
    resetHandAndSpeakState();
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

  fullscreenBtn.addEventListener("click", () => {
    if (remoteVideo.requestFullscreen) remoteVideo.requestFullscreen();
    else if (remoteVideo.webkitRequestFullscreen) remoteVideo.webkitRequestFullscreen();
  });
})();