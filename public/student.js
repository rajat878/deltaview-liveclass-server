(() => {
  // ── Screens ──────────────────────────────────────────────────────────────
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

  let socket    = null;
  let pc        = null;
  let roomId    = null;
  let teacherId = null;

  // ── FIX A: Pre-fill room code from URL query param (?room=XXXX) ──────────
  // The Android app now generates QR codes pointing to:
  //   https://deltaview-liveclass-server.onrender.com/?room=VGRH6K
  // Read that param and auto-fill + auto-connect so students don't have to
  // type the room code manually.
  const urlParams   = new URLSearchParams(window.location.search);
  const roomFromUrl = urlParams.get("room");
  if (roomFromUrl) {
    pinInput.value = roomFromUrl.toUpperCase();
    // Auto-connect after a short delay to let the page finish rendering
    window.addEventListener("DOMContentLoaded", () => {
      setTimeout(connect, 300);
    });
    // If DOMContentLoaded already fired (script is at bottom), connect now
    if (document.readyState !== "loading") {
      setTimeout(connect, 300);
    }
  }

  // ── ICE candidate buffer ──────────────────────────────────────────────────
  // FIX B: Teacher's ICE candidates arrive via socket BEFORE
  // pc.setRemoteDescription() completes (async). Calling pc.addIceCandidate()
  // before the remote description is set silently drops the candidate.
  // Buffer them and flush only after setRemoteDescription resolves.
  const pendingCandidates = [];
  let remoteDescSet = false;

  function bufferOrAddCandidate(candidate) {
    if (remoteDescSet && pc) {
      pc.addIceCandidate(new RTCIceCandidate(candidate))
        .catch((e) => console.warn("addIceCandidate failed:", e));
    } else {
      console.log("🧊 Buffering ICE candidate (remote desc not set yet)");
      pendingCandidates.push(candidate);
    }
  }

  function flushCandidates() {
    remoteDescSet = true;
    console.log(`🧊 Flushing ${pendingCandidates.length} buffered candidates`);
    while (pendingCandidates.length && pc) {
      pc.addIceCandidate(new RTCIceCandidate(pendingCandidates.shift()))
        .catch((e) => console.warn("addIceCandidate (flush) failed:", e));
    }
  }

  // ── FIX C (MAIN FIX): ICE config — STUN + TURN ───────────────────────────
  // The old config had only Google STUN. STUN lets a peer discover its public
  // IP but CANNOT relay traffic. When teacher and student are on different
  // networks (different Wi-Fi, mobile data, school/office symmetric NAT),
  // STUN-only ICE fails after ~15 seconds — exactly the bug you saw.
  //
  // TURN relays media when a direct path fails. Both sides MUST have TURN for
  // relay candidate pairs to form. The teacher (Android) already had these
  // Metered TURN credentials. Adding them here on the student side too means
  // a relay↔relay pair will always succeed regardless of NAT type or firewall.
  const RTC_CONFIG = {
    iceServers: [
      // ── STUN (no auth needed) ─────────────────────────────────────────────
      { urls: "stun:stun.relay.metered.ca:80" },
      { urls: "stun:stun.l.google.com:19302"  },

      // ── TURN UDP port 80 — fastest, try first ─────────────────────────────
      {
        urls:       "turn:in.relay.metered.ca:80",
        username:   "e93bee4c347d0e117a51a185",
        credential: "6klB8AQpfbNOJZcq",
      },

      // ── TURN TCP port 80 — fallback if UDP is blocked ─────────────────────
      {
        urls:       "turn:in.relay.metered.ca:80?transport=tcp",
        username:   "e93bee4c347d0e117a51a185",
        credential: "6klB8AQpfbNOJZcq",
      },

      // ── TURN port 443 — gets through most firewalls ───────────────────────
      {
        urls:       "turn:in.relay.metered.ca:443",
        username:   "e93bee4c347d0e117a51a185",
        credential: "6klB8AQpfbNOJZcq",
      },

      // ── TURNS TLS port 443 — gets through the strictest firewalls ─────────
      {
        urls:       "turns:in.relay.metered.ca:443?transport=tcp",
        username:   "e93bee4c347d0e117a51a185",
        credential: "6klB8AQpfbNOJZcq",
      },
    ],

    // Pre-gather candidates before negotiation starts → faster connection
    iceCandidatePoolSize: 10,
  };

  // ── Helpers ───────────────────────────────────────────────────────────────
  function show(screen) {
    [joinScreen, waitingScreen, liveScreen, endedScreen]
      .forEach((s) => s.classList.add("hidden"));
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

  // ── Socket / join ─────────────────────────────────────────────────────────
  function connect() {
    clearError();

    roomId = pinInput.value.trim().toUpperCase();
    if (!roomId) {
      showError("Please enter the room code.");
      return;
    }

    if (socket) socket.disconnect();

    // Reset candidate buffer state for a fresh connection
    pendingCandidates.length = 0;
    remoteDescSet = false;

    show(waitingScreen);

    socket = io(getServerUrl(), {
      transports: ["websocket", "polling"],
    });

    socket.on("connect", () => {
      console.log("✅ Connected to signaling server");
      socket.emit("join-room", { roomId, name: nameInput.value.trim() });
    });

    socket.on("connect_error", (err) => {
      console.error("Connection error:", err);
      show(joinScreen);
      showError("Could not reach the server. Check your internet connection.");
    });

    socket.on("join-success", (data) => {
      console.log("✅ Joined room:", data.roomId);
      // stay on waiting screen until teacher's offer arrives
    });

    socket.on("join-error", (data) => {
      show(joinScreen);
      showError(data.message || "Unable to join room.");
    });

    socket.on("room-ended", () => {
      console.log("❌ Room ended by teacher");
      cleanupPeerConnection();
      show(endedScreen);
    });

    socket.on("offer", async (data) => {
      console.log("📨 Offer received from teacher");
      teacherId = data.senderId;
      await handleOffer(data.senderId, data.roomId, data.sdp);
    });

    // FIX B continued: route all incoming candidates through the buffer
    socket.on("ice-candidate", (data) => {
      if (!pc) return;
      console.log("🧊 ICE candidate received from teacher");
      bufferOrAddCandidate(data.candidate);
    });

    socket.on("disconnect", () => {
      console.log("❌ Socket disconnected");
    });
  }

  // ── Offer handling ────────────────────────────────────────────────────────
  async function handleOffer(teacherIdArg, roomIdArg, sdpData) {
    // Reset buffer for this negotiation round
    remoteDescSet = false;
    pendingCandidates.length = 0;

    if (pc) pc.close();
    pc = new RTCPeerConnection(RTC_CONFIG);

    // FIX D: Attach srcObject as soon as a track arrives, then show the screen.
    // Also show the screen on ICE connected in case ontrack fired first but
    // srcObject wasn't ready yet (race on some browsers).
    pc.ontrack = (event) => {
      console.log("🎥 Remote track received, kind:", event.track.kind,
                  "streams:", event.streams.length);
      if (event.streams && event.streams[0]) {
        remoteVideo.srcObject = event.streams[0];
      }
      remoteVideo.play().catch((e) => console.warn("autoplay blocked:", e));
      show(liveScreen);
    };

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      console.log("🧊 Sending local candidate to teacher:", event.candidate.type);
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

    // FIX E: monitor iceConnectionState — it reports FAILED faster than
    // connectionState and matches what the Android side logs.
    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      console.log("ICE connection state:", s);
      if (s === "connected" || s === "completed") {
        if (remoteVideo.srcObject) show(liveScreen);
      }
      if (s === "failed") {
        console.warn("❌ ICE FAILED — attempting restart");
        pc.restartIce();
      }
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      console.log("Connection state:", s);
      if (s === "connected")  { show(liveScreen); }
      if (s === "failed") {
        console.error("Connection permanently failed");
        show(joinScreen);
        showError("Connection to the teacher failed. Please rejoin.");
        cleanupPeerConnection();
      }
    };

    // FIX F: log gathering state so we can see if TURN candidates appear
    pc.onicegatheringstatechange = () => {
      console.log("ICE gathering state:", pc.iceGatheringState);
    };

    try {
      const offer = new RTCSessionDescription({ type: "offer", sdp: sdpData.sdp });
      await pc.setRemoteDescription(offer);

      // FIX B flush point: remote desc is now set — flush all buffered candidates
      flushCandidates();

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      socket.emit("answer", {
        targetId: teacherIdArg,
        roomId:   roomIdArg,
        sdp: { type: answer.type, sdp: answer.sdp },
      });

      console.log("✅ Answer sent to teacher");
    } catch (e) {
      console.error("handleOffer failed:", e);
      show(joinScreen);
      showError("Failed to connect. Please try again.");
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────
  function cleanupPeerConnection() {
    pendingCandidates.length = 0;
    remoteDescSet = false;
    if (pc) { pc.close(); pc = null; }
    if (remoteVideo) {
      remoteVideo.pause();
      remoteVideo.srcObject = null;
    }
  }

  // ── Event listeners ───────────────────────────────────────────────────────
  joinBtn.addEventListener("click", connect);
  pinInput.addEventListener("keydown",  (e) => { if (e.key === "Enter") connect(); });
  nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") connect(); });
  rejoinBtn.addEventListener("click", () => {
    show(joinScreen);
    pinInput.value = roomFromUrl || "";
  });
  fullscreenBtn.addEventListener("click", () => {
    if      (remoteVideo.requestFullscreen)       remoteVideo.requestFullscreen();
    else if (remoteVideo.webkitRequestFullscreen) remoteVideo.webkitRequestFullscreen();
  });
})();