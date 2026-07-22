const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());

// ── FIX: this server previously had NO static file serving at all — no
// express.static, no res.sendFile anywhere. That means whatever a student's
// browser loaded at this server's URL was NOT the join-screen/video/camera
// UI in public/index.html + public/student.js — there was nothing wired up
// to serve them. Any UI change made to public/index.html or public/student.js
// (including the new camera button) silently never reached students until
// this was added. Must come BEFORE the "/" health-check route below, since
// Express serves in registration order and this will handle "/" itself
// (serving public/index.html) whenever that file exists.
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// In-memory room storage
const rooms = {};

// Health check — only reached for paths express.static didn't already
// serve a file for (e.g. if public/index.html is ever removed).
app.get("/", (req, res) => {
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
  socket.on("join-room", ({ roomId }) => {
    const room = rooms[roomId];

    if (!room) {
      socket.emit("join-error", {
        message: "Room not found",
      });
      return;
    }

    room.students.push(socket.id);
    socket.join(roomId);

    console.log(`👨‍🎓 Student ${socket.id} joined ${roomId}`);

    // Notify student
    socket.emit("join-success", {
      roomId: roomId,
    });

    // Notify teacher
    io.to(room.teacher).emit("student-joined", {
      studentId: socket.id,
    });
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
    }
  });
});

const PORT = 3000;

server.listen(PORT, () => {
  console.log(`🚀 Server started on http://localhost:${PORT}`);
});