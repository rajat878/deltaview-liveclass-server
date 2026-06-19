const express = require("express");
const http = require("http");
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
  // FIX 1: allow old Socket.IO protocol (used by Android io.socket:socket.io-client:2.1.1)
  allowEIO3: true,
});

// In-memory room storage
const rooms = {};

// Serve student web page
app.use(express.static("public"));

// Health check endpoint
app.get("/health", (req, res) => res.json({ status: "ok", rooms: Object.keys(rooms).length }));

io.on("connection", (socket) => {
  console.log(`✅ Client connected: ${socket.id}`);

  // ==========================
  // Teacher creates a room
  // ==========================
  socket.on("create-room", () => {
    // FIX 2: Generate a 6-char alphanumeric room code (matches what server already did)
    // and expose it as both roomId and pin so the Android app and student page agree
    const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();

    rooms[roomId] = {
      teacher: socket.id,
      students: [],
    };

    socket.join(roomId);
    console.log(`🏫 Room created: ${roomId}`);

    socket.emit("room-created", { roomId });
  });

  // ==========================
  // Student joins a room
  // ==========================
  socket.on("join-room", ({ roomId }) => {
    // Normalise to uppercase so students don't have to worry about case
    const normalised = (roomId || "").trim().toUpperCase();
    const room = rooms[normalised];

    if (!room) {
      socket.emit("join-error", { message: "Room not found. Check the code and try again." });
      return;
    }

    room.students.push(socket.id);
    socket.join(normalised);
    console.log(`👨‍🎓 Student ${socket.id} joined ${normalised}`);

    socket.emit("join-success", { roomId: normalised });

    // Notify teacher — include updated student count
    io.to(room.teacher).emit("student-joined", {
      studentId: socket.id,
      studentCount: room.students.length,
    });
  });

  // ==========================
  // Relay WebRTC Offer
  // ==========================
  socket.on("offer", ({ targetId, roomId, sdp }) => {
    console.log(`📨 Offer: ${socket.id} -> ${targetId} (Room: ${roomId})`);
    io.to(targetId).emit("offer", { senderId: socket.id, roomId, sdp });
  });

  // ==========================
  // Relay WebRTC Answer
  // ==========================
  socket.on("answer", ({ targetId, roomId, sdp }) => {
    console.log(`📨 Answer: ${socket.id} -> ${targetId} (Room: ${roomId})`);
    io.to(targetId).emit("answer", { senderId: socket.id, roomId, sdp });
  });

  // ==========================
  // Relay ICE Candidate
  // ==========================
  socket.on("ice-candidate", ({ targetId, roomId, candidate }) => {
    console.log(`🧊 ICE: ${socket.id} -> ${targetId} (Room: ${roomId})`);
    io.to(targetId).emit("ice-candidate", { senderId: socket.id, roomId, candidate });
  });

  // ==========================
  // Client disconnect
  // ==========================
  socket.on("disconnect", () => {
    console.log(`❌ Client disconnected: ${socket.id}`);

    for (const roomId in rooms) {
      const room = rooms[roomId];

      if (room.teacher === socket.id) {
        console.log(`🛑 Closing room ${roomId} (teacher left)`);
        io.to(roomId).emit("room-ended");
        delete rooms[roomId];
        continue;
      }

      const before = room.students.length;
      room.students = room.students.filter((id) => id !== socket.id);
      if (room.students.length < before) {
        // Notify teacher a student left
        io.to(room.teacher).emit("student-left", {
          studentId: socket.id,
          studentCount: room.students.length,
        });
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`   Student join page: http://localhost:${PORT}`);
});
