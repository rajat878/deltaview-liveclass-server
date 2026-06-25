// ─────────────────────────────────────────────────────────────────────────────
// DeltaView Live Class – Signaling Server  (Node.js + Socket.IO)
// Deploy on Render / Railway / any Node host.
// ─────────────────────────────────────────────────────────────────────────────
const { createServer } = require("http");
const { Server }       = require("socket.io");

const PORT = process.env.PORT || 3000;

const httpServer = createServer((req, res) => {
  res.writeHead(200);
  res.end("DeltaView signaling server running");
});

const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// roomId → { teacherSocketId, students: Set<socketId> }
const rooms = new Map();

io.on("connection", (socket) => {
  console.log("connect", socket.id);

  // ── Teacher creates a room ──────────────────────────────────────────
  socket.on("create-room", () => {
    const roomId = Math.random().toString(36).slice(2, 8).toUpperCase();
    rooms.set(roomId, { teacherSocketId: socket.id, students: new Set() });
    socket.join(roomId);
    socket.emit("room-created", { roomId });
    console.log("room-created", roomId);
  });

  // ── Student joins ───────────────────────────────────────────────────
  socket.on("join-room", ({ roomId, name }) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit("join-error", { message: "Room not found. Check the code and try again." });
      return;
    }
    room.students.add(socket.id);
    socket.join(roomId);
    socket.data.roomId      = roomId;
    socket.data.displayName = name || "";

    socket.emit("join-success", { roomId });

    // Tell the teacher a new student arrived
    io.to(room.teacherSocketId).emit("student-joined", {
      studentId:   socket.id,
      displayName: name || "",
    });
    console.log("student-joined", socket.id, "→ room", roomId);
  });

  // ── WebRTC signaling passthrough ────────────────────────────────────
  socket.on("offer", (data) => {
    io.to(data.targetId).emit("offer", { ...data, senderId: socket.id });
  });

  socket.on("answer", (data) => {
    io.to(data.targetId).emit("answer", { ...data, senderId: socket.id });
  });

  socket.on("ice-candidate", (data) => {
    io.to(data.targetId).emit("ice-candidate", { ...data, senderId: socket.id });
  });

  // ── Teacher ends the room ───────────────────────────────────────────
  // THE KEY FIX: forward downloadUrl (if present) to every student so
  // the browser can show the download button.
  socket.on("end-room", ({ roomId, downloadUrl }) => {
    console.log("end-room", roomId, "downloadUrl:", downloadUrl || "(none)");

    const room = rooms.get(roomId);
    if (!room) return;

    // Build the payload – include downloadUrl only when the teacher sent one
    const payload = downloadUrl ? { downloadUrl } : {};

    // Broadcast to every student in the room
    room.students.forEach((studentId) => {
      io.to(studentId).emit("room-ended", payload);
    });

    rooms.delete(roomId);
  });

  // ── Cleanup on disconnect ───────────────────────────────────────────
  socket.on("disconnect", () => {
    console.log("disconnect", socket.id);

    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    if (room.teacherSocketId === socket.id) {
      // Teacher disconnected unexpectedly – notify students
      room.students.forEach((sid) => {
        io.to(sid).emit("room-ended", {});
      });
      rooms.delete(roomId);
    } else {
      room.students.delete(socket.id);
      io.to(room.teacherSocketId).emit("student-left", { studentId: socket.id });
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`Signaling server listening on port ${PORT}`);
});