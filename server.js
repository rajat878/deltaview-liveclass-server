const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// In-memory room storage
const rooms = {};

// Serve the student join page (index.html, student.js, and the socket.io
// client script) from the public/ folder. This MUST be registered before
// the "/" health-check route below — Express matches routes in the order
// they're added, so if the health check ran first it would intercept every
// request to "/" and the actual join page would never be reached (which is
// exactly why students were only ever seeing the plain health-check text).
app.use(express.static(path.join(__dirname, "public")));

// Health check (kept for uptime monitors / Render's own health probes).
// Static files are matched first, so this only fires for paths that don't
// match a file in public/ (e.g. Render pinging some other route).
app.get("/health", (req, res) => {
  res.send("Live Class Signaling Server Running");
});

io.on("connection", (socket) => {
  console.log(`✅ Client connected: ${socket.id}`);

  // ==========================
  // Teacher creates a room
  // ==========================
  socket.on("create-room", () => {
    const roomId = Math.random()
      .toString(36)
      .substring(2, 8)
      .toUpperCase();

rooms[roomId] = {
  teacher: socket.id,
  students: [],
  raisedHands: new Set(),     // studentIds with hand currently raised
  allowedSpeakers: new Set(), // studentIds the teacher has granted mic permission to
};

    socket.join(roomId);

    console.log(`🏫 Room created: ${roomId}`);

    socket.emit("room-created", {
      roomId: roomId,
    });
  });

  // ==========================
  // Student joins a room
  // ==========================
  socket.on("join-room", ({ roomId, name }) => {
    const room = rooms[roomId];

    if (!room) {
      socket.emit("join-error", {
        message: "Room not found",
      });
      return;
    }

    // Remember the name the student typed so it survives for the life of
    // the room (useful if we ever need to look it up again later).
    const displayName = typeof name === "string" && name.trim() ? name.trim() : null;
    room.students.push(socket.id);
    room.studentNames = room.studentNames || {};
    room.studentNames[socket.id] = displayName;
    socket.join(roomId);

    console.log(`👨‍🎓 Student ${socket.id} (${displayName || "no name given"}) joined ${roomId}`);

    // Notify student
    socket.emit("join-success", {
      roomId: roomId,
    });

    // Notify teacher — this is what the Android app reads to show the
    // student's real name instead of falling back to "Student N".
    io.to(room.teacher).emit("student-joined", {
      studentId: socket.id,
      displayName: displayName,
    });
  });

// ==========================
// Student raises / lowers hand
// ==========================
socket.on("raise-hand", ({ roomId }) => {
  const room = rooms[roomId];
  if (!room) return;

  room.raisedHands.add(socket.id);

  console.log(`✋ Hand raised: ${socket.id} (Room: ${roomId})`);

  io.to(room.teacher).emit("hand-raised", { studentId: socket.id });
});

socket.on("lower-hand", ({ roomId }) => {
  const room = rooms[roomId];
  if (!room) return;

  room.raisedHands.delete(socket.id);

  console.log(`🖐️ Hand lowered: ${socket.id} (Room: ${roomId})`);

  io.to(room.teacher).emit("hand-lowered", { studentId: socket.id });
});

// ==========================
// Teacher grants / revokes mic permission
// ==========================
socket.on("allow-speak", ({ roomId, studentId }) => {
  const room = rooms[roomId];
  if (!room || socket.id !== room.teacher) return; // only the teacher may grant this

  room.allowedSpeakers.add(studentId);
  room.raisedHands.delete(studentId); // granting speech implicitly clears the raised hand

  console.log(`🎤 Speak allowed: ${studentId} (Room: ${roomId})`);

  io.to(studentId).emit("speak-allowed");
});

socket.on("mute-student", ({ roomId, studentId }) => {
  const room = rooms[roomId];
  if (!room || socket.id !== room.teacher) return; // only the teacher may revoke this

  room.allowedSpeakers.delete(studentId);

  console.log(`🔇 Speak revoked: ${studentId} (Room: ${roomId})`);

  io.to(studentId).emit("speak-muted");
});

// ==========================
// Relay WebRTC Offer
// ==========================
socket.on("offer", ({ targetId, roomId, sdp }) => {
  console.log(
    `📨 Offer: ${socket.id} -> ${targetId} (Room: ${roomId})`
  );

  io.to(targetId).emit("offer", {
    senderId: socket.id,
    roomId,
    sdp,
  });
});

// Relay WebRTC Answer
// ==========================
socket.on("answer", ({ targetId, roomId, sdp }) => {
  console.log(
    `📨 Answer: ${socket.id} -> ${targetId} (Room: ${roomId})`
  );

  io.to(targetId).emit("answer", {
    senderId: socket.id,
    roomId,
    sdp,
  });
});


// ==========================
// Relay ICE Candidate
// ==========================
socket.on("ice-candidate", ({ targetId, roomId, candidate }) => {
  console.log(
    `🧊 ICE Candidate: ${socket.id} -> ${targetId} (Room: ${roomId})`
  );

  io.to(targetId).emit("ice-candidate", {
    senderId: socket.id,
    roomId,
    candidate,
  });
});

  // ==========================
  // Client disconnect
  // ==========================
  socket.on("disconnect", () => {
    console.log(`❌ Client disconnected: ${socket.id}`);

    // Clean up rooms
    for (const roomId in rooms) {
      const room = rooms[roomId];

      // Teacher disconnected
      if (room.teacher === socket.id) {
        console.log(`🛑 Closing room ${roomId}`);

        io.to(roomId).emit("room-ended");

        delete rooms[roomId];
        continue;
      }

      // Remove student
      room.students = room.students.filter(
        (studentId) => studentId !== socket.id
      );
      room.raisedHands.delete(socket.id);
      room.allowedSpeakers.delete(socket.id);
      if (room.studentNames) delete room.studentNames[socket.id];
    }
  });
});

const PORT = 3000;

server.listen(PORT, () => {
  console.log(`🚀 Server started on http://localhost:${PORT}`);
});