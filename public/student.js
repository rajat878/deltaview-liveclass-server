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
  const recIndicator  = document.getElementById("rec-indicator");
  const downloadBtn   = document.getElementById("download-btn");
  const downloadSize  = document.getElementById("download-size");

  let socket    = null;
  let pc        = null;
  let roomId    = null;
  let teacherId = null;

  // ── MediaRecorder state ───────────────────────────────────────────────
  let mediaRecorder   = null;
  let recordedChunks  = [];
  let recordingMime   = "";
  let studentNameForFile = "student";

  const RTC_CONFIG = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
    ],
  };

  // ── Helpers ───────────────────────────────────────────────────────────
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

  // Pick the best supported MIME type for MediaRecorder
  function getSupportedMime() {
    const candidates = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
      "video/mp4",
    ];
    for (const mime of candidates) {
      if (MediaRecorder.isTypeSupported(mime)) return mime;
    }
    return ""; // browser default
  }

  // Format bytes → "12.4 MB" etc.
  function formatBytes(bytes) {
    if (bytes < 1024)       return bytes + " B";
    if (bytes < 1048576)    return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1048576).toFixed(1) + " MB";
  }

  // ── Recording ─────────────────────────────────────────────────────────
  function startRecording(stream) {
    if (!window.MediaRecorder) {
      console.warn("MediaRecorder not supported in this browser — recording disabled");
      return;
    }
    recordedChunks = [];
    recordingMime  = getSupportedMime();

    try {
      const options = recordingMime ? { mimeType: recordingMime } : {};
      mediaRecorder = new MediaRecorder(stream, options);
    } catch (e) {
      console.error("MediaRecorder init failed:", e);
      return;
    }

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) recordedChunks.push(e.data);
    };

    mediaRecorder.onerror = (e) => {
      console.error("MediaRecorder error:", e);
    };

    // Collect a chunk every 5 s so memory doesn't grow unbounded for long classes
    mediaRecorder.start(5000);
    console.log("🔴 Recording started, mime:", recordingMime || "browser default");

    if (recIndicator) recIndicator.classList.remove("hidden");
  }

  function stopRecording() {
    return new Promise((resolve) => {
      if (!mediaRecorder || mediaRecorder.state === "inactive") {
        resolve(null);
        return;
      }
      mediaRecorder.onstop = () => {
        if (recIndicator) recIndicator.classList.add("hidden");
        if (recordedChunks.length === 0) { resolve(null); return; }

        const mime = recordingMime || "video/webm";
        const blob = new Blob(recordedChunks, { type: mime });
        recordedChunks = [];
        resolve(blob);
      };
      mediaRecorder.stop();
    });
  }

  async function finaliseRecording() {
    const blob = await stopRecording();
    if (!blob || blob.size === 0) {
      console.warn("No recording data available");
      return;
    }

    // Build a safe filename: "DeltaView_LiveClass_Priya_2026-06-24.webm"
    const ext  = recordingMime.includes("mp4") ? "mp4" : "webm";
    const date = new Date().toISOString().slice(0, 10);
    const safe = studentNameForFile.replace(/[^a-z0-9]/gi, "_").slice(0, 20);
    const filename = `DeltaView_LiveClass_${safe}_${date}.${ext}`;

    const url = URL.createObjectURL(blob);

    // Wire up the download button
    downloadBtn.href     = url;
    downloadBtn.download = filename;
    downloadBtn.classList.remove("hidden");

    // Show file size hint
    if (downloadSize) {
      downloadSize.textContent = `Recording ready · ${formatBytes(blob.size)}`;
      downloadSize.classList.remove("hidden");
    }

    console.log(`✅ Recording ready: ${filename} (${formatBytes(blob.size)})`);

    // Free the object URL once the user has clicked download
    downloadBtn.addEventListener("click", () => {
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }, { once: true });
  }

  // ── Connection ────────────────────────────────────────────────────────
  function connect() {
    clearError();

    roomId = pinInput.value.trim().toUpperCase();
    if (!roomId) { showError("Please enter the room code."); return; }

    const studentName = nameInput.value.trim();
    if (!studentName) {
      showError("Please enter your name.");
      nameInput.focus();
      return;
    }
    studentNameForFile = studentName;

    if (socket) socket.disconnect();

    // Reset any leftover download state from a previous session
    downloadBtn.classList.add("hidden");
    downloadBtn.removeAttribute("href");
    if (downloadSize) downloadSize.classList.add("hidden");
    recordedChunks = [];

    show(waitingScreen);

    socket = io(getServerUrl(), { transports: ["websocket", "polling"] });

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
    });

    socket.on("join-error", (data) => {
      show(joinScreen);
      showError(data.message || "Unable to join room.");
    });

    socket.on("room-ended", async () => {
      console.log("❌ Room ended by teacher");
      cleanupPeerConnection();
      await finaliseRecording();   // stop recorder & prepare download
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

  async function handleOffer(teacherIdArg, roomIdArg, sdpData) {
    if (pc) pc.close();
    pc = new RTCPeerConnection(RTC_CONFIG);

   pc.ontrack = (event) => {
       const stream = event.streams[0];
       remoteVideo.srcObject = stream;
       remoteVideo.play().catch((err) => console.error(err));
       show(liveScreen);

       // Wait for stream to stabilize before recording
       // (ontrack fires per-track; defer to after all tracks arrive)
       clearTimeout(recordingStartTimer);
       recordingStartTimer = setTimeout(() => startRecording(stream), 500);
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
      await pc.setRemoteDescription(new RTCSessionDescription({ type: "offer", sdp: sdpData.sdp }));
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

  // ── Event listeners ───────────────────────────────────────────────────
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