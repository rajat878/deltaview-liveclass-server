(() => {
  // ── Screens ──────────────────────────────────────────────────────────
  const joinScreen = document.getElementById("join-screen");
  const waitingScreen = document.getElementById("waiting-screen");
  const liveScreen = document.getElementById("live-screen");
  const endedScreen = document.getElementById("ended-screen");

  const joinBtn = document.getElementById("join-btn");
  const pinInput = document.getElementById("pin-input");
  const nameInput = document.getElementById("name-input");
  const joinError = document.getElementById("join-error");
  const remoteVideo = document.getElementById("remote-video");
  const fullscreenBtn = document.getElementById("fullscreen-btn");
  const rejoinBtn = document.getElementById("rejoin-btn");

  let socket = null;
  let pc = null;
  let roomId = null;
  let teacherId = null;

  // FIX 3: real ICE config — STUN so peers behind NAT/different networks
  // can discover their public address and (try to) connect directly.
  // Google's public STUN servers are free and require no signup.
  // NOTE: STUN alone is not enough for every network (symmetric NAT,
  // some corporate/school firewalls) — a TURN relay is needed for those.
  // See the "still need a TURN server" note in the chat reply.
  const RTC_CONFIG = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      // Add your TURN server here once you have one, e.g.:
      // { urls: "turn:your-turn-host:3478", username: "user", credential: "pass" },
    ],
  };

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

  // FIX 4: connect to whatever host served this page — no hardcoded LAN IP.
  // Works automatically wherever the server is deployed (LAN, cloud, ngrok…).
  function getServerUrl() {
    return window.location.origin;
  }

  function connect() {
    clearError();

    roomId = pinInput.value.trim().toUpperCase();
    if (!roomId) {
      showError("Please enter the room code.");
      return;
    }

    const studentName = nameInput.value.trim();
    if (!studentName) {
      showError("Please enter your name.");
      nameInput.focus();
      return;
    }

    if (socket) {
      socket.disconnect();
    }

    show(waitingScreen);

    socket = io(getServerUrl(), {
      // Allow polling fallback too — some networks block raw websockets
      transports: ["websocket", "polling"],
    });

    socket.on("connect", () => {
      console.log("✅ Connected to signaling server");
      socket.emit("join-room", { roomId, name: studentName });
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

    socket.on("room-ended", () => {
      console.log("❌ Room ended by teacher");
      cleanupPeerConnection();
      show(endedScreen);
    });

    socket.on("offer", async (data) => {
      console.log("📨 Offer received");
      teacherId = data.senderId;
      await handleOffer(data.senderId, data.roomId, data.sdp);
    });

    socket.on("ice-candidate", async (data) => {
      if (!pc) return;
      try {
        const candidate = data.candidate;
        await pc.addIceCandidate(
          new RTCIceCandidate({
            candidate: candidate.candidate,
            sdpMid: candidate.sdpMid,
            sdpMLineIndex: candidate.sdpMLineIndex,
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
        roomId: roomIdArg,
        candidate: {
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
        },
      });
    };

    pc.onconnectionstatechange = () => {
      console.log("WebRTC state:", pc.connectionState);
      switch (pc.connectionState) {
        case "connected":
          show(liveScreen);
          break;
        case "disconnected":
          // Brief blips are normal — give it a few seconds before reacting
          break;
        case "failed":
          console.error("Connection failed");
          show(joinScreen);
          showError("Connection to the teacher failed. Please rejoin.");
          cleanupPeerConnection();
          break;
        case "closed":
          break;
      }
    };

    try {
      const offer = new RTCSessionDescription({ type: "offer", sdp: sdpData.sdp });
      await pc.setRemoteDescription(offer);

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      socket.emit("answer", {
        targetId: teacherIdArg,
        roomId: roomIdArg,
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
    if (pc) {
      pc.close();
      pc = null;
    }
    if (remoteVideo) {
      remoteVideo.pause();
      remoteVideo.srcObject = null;
    }
  }

  joinBtn.addEventListener("click", connect);
  pinInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") connect();
  });
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") connect();
  });
  rejoinBtn.addEventListener("click", () => {
    show(joinScreen);
    pinInput.value = "";
  });
  fullscreenBtn.addEventListener("click", () => {
    if (remoteVideo.requestFullscreen) remoteVideo.requestFullscreen();
    else if (remoteVideo.webkitRequestFullscreen) remoteVideo.webkitRequestFullscreen();
  });
})();