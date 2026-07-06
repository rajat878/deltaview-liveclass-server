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
    remoteVideo, fullscreenBtn, rejoinBtn,
  };
  const missing = Object.entries(required)
    .filter(([, el]) => !el)
    .map(([name]) => name);
  if (missing.length > 0) {
    showFatalError(`Page failed to load correctly (missing: ${missing.join(", ")})`);
    return; // bail out before wiring up anything that would just throw
  }

  let socket    = null;
  let pc        = null;
  let roomId    = null;

  const RTC_CONFIG = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
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

    show(waitingScreen);

    const waitingSubtitle = waitingScreen.querySelector(".subtitle");
    const slowConnectTimer = setTimeout(() => {
      if (waitingSubtitle) {
        waitingSubtitle.textContent =
          "Still connecting — the server may be waking up, this can take up to a minute…";
      }
    }, 8000);

    socket = io(getServerUrl(), { transports: ["websocket", "polling"] });

    socket.on("connect", () => {
      clearTimeout(slowConnectTimer);
      console.log("✅ Connected to signaling server");
      socket.emit("join-room", { roomId, name: nameInput.value.trim() });
    });

    socket.on("connect_error", (err) => {
      clearTimeout(slowConnectTimer);
      console.error("Connection error:", err);
      show(joinScreen);
      showError("Could not reach the server. Check your internet connection.");
    });

    socket.on("join-success", (data) => {
      console.log("✅ Joined room:", data.roomId);
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
      console.log("📨 Offer received");
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
        console.error("Failed to add ICE candidate", e);
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
      console.log("🎥 Remote stream received");
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
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit("answer", {
        targetId: teacherIdArg,
        roomId:   roomIdArg,
        sdp: { type: answer.type, sdp: answer.sdp },
      });
      console.log("✅ Answer sent");
    } catch (e) {
      console.error("handleOffer failed", e);
      show(joinScreen);
      showError("Failed to connect. Please try again.");
    }
  }

  function cleanupPeerConnection() {
    if (pc) { pc.close(); pc = null; }
    if (remoteVideo) { remoteVideo.pause(); remoteVideo.srcObject = null; }
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

  fullscreenBtn.addEventListener("click", () => {
    if (remoteVideo.requestFullscreen) remoteVideo.requestFullscreen();
    else if (remoteVideo.webkitRequestFullscreen) remoteVideo.webkitRequestFullscreen();
  });
})();