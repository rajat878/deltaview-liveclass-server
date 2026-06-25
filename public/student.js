(() => {
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

  // ── Download UI ──────────────────────────────────────────────────────
  const downloadBtn    = document.getElementById("download-btn");
  const downloadStatus = document.getElementById("download-status");

  let socket   = null;
  let pc       = null;
  let roomId   = null;
  let teacherId = null;

  const RTC_CONFIG = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      // Add TURN server here if needed for restrictive networks
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

  // ── finaliseRecording: called when "room-ended" carries a download URL ──
  function finaliseRecording(downloadUrl) {
    if (!downloadUrl) {
      // Teacher ended without a recording URL — just show the ended screen
      downloadStatus.textContent = "No recording available for this session.";
      return;
    }

    downloadBtn.href = downloadUrl;
    downloadBtn.classList.remove("hidden");
    downloadStatus.textContent = "Recording is ready — tap the button to save it.";
  }

  // ── Connect ──────────────────────────────────────────────────────────
  function connect() {
    clearError();

    roomId = pinInput.value.trim().toUpperCase();
    if (!roomId) {
      showError("Please enter the room code.");
      return;
    }

    if (socket) {
      socket.disconnect();
    }

    // Reset download UI on each new join
    downloadBtn.classList.add("hidden");
    downloadBtn.href = "";
    downloadStatus.textContent = "";

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
      // stay on waiting screen until the teacher's offer arrives
    });

    socket.on("join-error", (data) => {
      show(joinScreen);
      showError(data.message || "Unable to join room.");
    });

    // ── KEY FIX: "room-ended" now carries an optional downloadUrl ────────
    // The teacher's Android app calls endSession(), which emits "end-room"
    // to the signaling server with { roomId, downloadUrl? }.
    // The server forwards "room-ended" with that same payload to all students.
    socket.on("room-ended", (data) => {
      console.log("❌ Room ended by teacher", data);
      cleanupPeerConnection();
      show(endedScreen);

      // data may be undefined (server sent no payload) or { downloadUrl: "..." }
      const url = data && data.downloadUrl ? data.downloadUrl : null;
      finaliseRecording(url);
    });

    socket.on("offer", async (data) => {
      console.log("📨 Offer received");
      teacherId = data.senderId;
      await handleOffer(data.senderId, data.roomId, data.sdp);
    });

    socket.on("ice-candidate", async (data) => {
      if (!pc) return;
      try {
        await pc.addIceCandidate(
          new RTCIceCandidate({
            candidate:     data.candidate.candidate,
            sdpMid:        data.candidate.sdpMid,
            sdpMLineIndex: data.candidate.sdpMLineIndex,
          })
        );
        console.log("🧊 ICE candidate added");
      } catch (e) {
        console.error("Failed to add ICE candidate", e);
      }
    });

    socket.on("disconnect", () => {
      console.log("❌ Socket disconnected");
    });
  }

  // ── WebRTC offer handling ────────────────────────────────────────────
  async function handleOffer(teacherIdArg, roomIdArg, sdpData) {
    if (pc) pc.close();

    pc = new RTCPeerConnection(RTC_CONFIG);

    pc.ontrack = (event) => {
      console.log("🎥 Remote stream received");
      remoteVideo.srcObject = event.streams[0];
      remoteVideo.play().catch((err) => console.error(err));
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
      console.log("WebRTC state:", pc.connectionState);
      switch (pc.connectionState) {
        case "connected":    show(liveScreen); break;
        case "disconnected": break;
        case "failed":
          console.error("Connection failed");
          show(joinScreen);
          showError("Connection to the teacher failed. Please rejoin.");
          cleanupPeerConnection();
          break;
        case "closed": break;
      }
    };

    try {
      const offer = new RTCSessionDescription({ type: "offer", sdp: sdpData.sdp });
      await pc.setRemoteDescription(offer);

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

  // ── Event listeners ──────────────────────────────────────────────────
  joinBtn.addEventListener("click", connect);
  pinInput.addEventListener("keydown",  (e) => { if (e.key === "Enter") connect(); });
  nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") connect(); });

  rejoinBtn.addEventListener("click", () => {
    show(joinScreen);
    pinInput.value = "";
  });

  fullscreenBtn.addEventListener("click", () => {
    if (remoteVideo.requestFullscreen)       remoteVideo.requestFullscreen();
    else if (remoteVideo.webkitRequestFullscreen) remoteVideo.webkitRequestFullscreen();
  });
})();