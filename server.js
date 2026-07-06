// ─────────────────────────────────────────────────────────────────────────────
// DeltaView Live Class – Signaling Server  (Node.js + Socket.IO)
// Now also serves the student web page at /join?room=ROOMCODE
// ─────────────────────────────────────────────────────────────────────────────
const { createServer } = require("http");
const { Server }       = require("socket.io");
const path             = require("path");
const fs               = require("fs");
const url              = require("url");

const PORT = process.env.PORT || 3000;

// ── Read the static files once at startup ────────────────────────────────────
// Place index.html and student.js in a "public/" folder next to server.js
const PUBLIC_DIR = path.join(__dirname, "public");

function serveStatic(res, filePath, contentType) {
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const httpServer = createServer((req, res) => {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // Serve the student join page
  if (pathname === "/" || pathname === "/join") {
    serveStatic(res, path.join(PUBLIC_DIR, "index.html"), "text/html; charset=utf-8");
    return;
  }

  // Serve student.js
  if (pathname === "/student.js") {
    serveStatic(res, path.join(PUBLIC_DIR, "student.js"), "application/javascript");
    return;
  }

  // Socket.IO handles /socket.io/* automatically — don't intercept it
  if (pathname.startsWith("/socket.io")) {
    return; // let Socket.IO middleware handle it
  }

  res.writeHead(404);
  res.end("Not found");
});

// ── Socket.IO ─────────────────────────────────────────────────────────────────
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
  socket.on("end-room", ({ roomId }) => {
    console.log("end-room", roomId);
    const room = rooms.get(roomId);
    if (!room) return;

    room.students.forEach((studentId) => {
      io.to(studentId).emit("room-ended", {});
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
      room.students.forEach((sid) => io.to(sid).emit("room-ended", {}));
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