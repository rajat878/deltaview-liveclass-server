const express = require("express");
const http    = require("http");
const path    = require("path");
const { Server } = require("socket.io");
const cors    = require("cors");

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  allowEIO3: true,   // Android Socket.IO client 2.x compatibility
});

// ── In-memory room storage ────────────────────────────────────────────────────
const rooms = {};

// ── Static files — NO cache so updated student.js always loads fresh ──────────
app.use(express.static(path.join(__dirname, "public"), {
  etag:         false,
  lastModified: false,
  setHeaders(res) {
    res.setHeader("Cache-Control", "no-store");
  },
}));

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    rooms:  Object.keys(rooms).length,
    activeRooms: Object.entries(rooms).map(([id, r]) => ({
      id, students: r.students.length,
    })),
  });
});

// ── Socket.IO ─────────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log(`✅ connected: ${socket.id}`);

  socket.on("create-room", () => {
    const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
    rooms[roomId] = { teacher: socket.id, students: [] };
    socket.join(roomId);
    console.log(`🏫 room created: ${roomId}`);
    socket.emit("room-created", { roomId });
  });

  // FIX: destructure 'name' alongside 'roomId' so it isn't silently dropped
  socket.on("join-room", ({ roomId, name }) => {
    const id   = (roomId || "").trim().toUpperCase();
    const room = rooms[id];
    if (!room) {
      socket.emit("join-error", { message: "Room not found. Check the code and try again." });
      return;
    }
    // FIX: store the student name alongside their socket id
    const displayName = (name || "").trim() || null;
    room.students.push({ id: socket.id, name: displayName });
    socket.join(id);
    console.log(`👨‍🎓 student ${socket.id} (${displayName || "unnamed"}) joined ${id}`);
    socket.emit("join-success", { roomId: id });
    // FIX: forward the name to the teacher as 'displayName'
    io.to(room.teacher).emit("student-joined", {
      studentId:    socket.id,
      displayName:  displayName,
      studentCount: room.students.length,
    });
  });

  socket.on("offer",         ({ targetId, roomId, sdp })       =>
    io.to(targetId).emit("offer",         { senderId: socket.id, roomId, sdp }));

  socket.on("answer",        ({ targetId, roomId, sdp })       =>
    io.to(targetId).emit("answer",        { senderId: socket.id, roomId, sdp }));

  socket.on("ice-candidate", ({ targetId, roomId, candidate }) => {
    const type = candidate?.candidate?.split(" ")[7] || "?";
    console.log(`🧊 ICE [${type}]: ${socket.id} → ${targetId}`);
    io.to(targetId).emit("ice-candidate", { senderId: socket.id, roomId, candidate });
  });

  socket.on("end-room", ({ roomId }) => {
    const id = (roomId || "").trim().toUpperCase();
    if (rooms[id]?.teacher === socket.id) {
      io.to(id).emit("room-ended");
      delete rooms[id];
    }
  });

  socket.on("disconnect", () => {
    console.log(`❌ disconnected: ${socket.id}`);
    for (const id in rooms) {
      const room = rooms[id];
      if (room.teacher === socket.id) {
        io.to(id).emit("room-ended");
        delete rooms[id];
        continue;
      }
      const before = room.students.length;
      // FIX: filter by .id since students are now objects {id, name}
      room.students = room.students.filter((s) => s.id !== socket.id);
      if (room.students.length < before) {
        io.to(room.teacher).emit("student-left", {
          studentId: socket.id, studentCount: room.students.length,
        });
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 server on port ${PORT}`));