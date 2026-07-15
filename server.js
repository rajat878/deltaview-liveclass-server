const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const cors = require("cors");
const { randomUUID } = require("crypto"); // built into Node — avoids the uuid package's ESM-only require() issue
const db = require("./db");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// In-memory room storage
const rooms = {};

// How many recent chat messages we keep per room so a student who joins
// mid-class (or reopens the chat drawer) has some context, without letting
// a long session's history grow unbounded in memory.
const CHAT_HISTORY_LIMIT = 100;

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

// ==========================
// Roster REST API — teacher builds this list once (e.g. from a settings
// screen) and it's reused across every future session, independent of any
// single room/PIN.
// ==========================

// List all students in the roster.
app.get("/api/roster", (req, res) => {
  res.json(db.getRoster());
});

// Add (or rename, if the code already exists) a student.
app.post("/api/roster", (req, res) => {
  const { code, name } = req.body || {};
  const cleanCode = typeof code === "string" ? code.trim() : "";
  const cleanName = typeof name === "string" ? name.trim() : "";
  if (!cleanCode || !cleanName) {
    return res.status(400).json({ error: "Both code and name are required" });
  }
  const student = db.addStudent(cleanCode, cleanName);
  res.status(201).json(student);
});

// Remove a student from the roster.
app.delete("/api/roster/:code", (req, res) => {
  const removed = db.removeStudent(req.params.code);
  if (!removed) return res.status(404).json({ error: "Student code not found" });
  res.json({ ok: true });
});

// ==========================
// Attendance REST API
// ==========================

// List past + in-progress sessions with a quick attendee count, newest first.
app.get("/api/sessions", (req, res) => {
  res.json(db.listSessions());
});

// Full per-student attendance detail for one session.
app.get("/api/sessions/:sessionId/attendance", (req, res) => {
  res.json(db.getSessionAttendance(req.params.sessionId));
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

    const sessionId = randomUUID();

rooms[roomId] = {
  teacher: socket.id,
  sessionId,                  // ties this room's lifetime to one persisted attendance session
  students: [],
  attendanceRows: {},          // studentId (socket.id) -> attendance row id, so disconnect can close it out
  raisedHands: new Set(),     // studentIds with hand currently raised
  allowedSpeakers: new Set(), // studentIds the teacher has granted mic permission to
  chatHistory: [],            // rolling log of { id, senderId, senderName, role, text, ts }, capped at CHAT_HISTORY_LIMIT
};

    db.startSession(sessionId, roomId);

    socket.join(roomId);

    console.log(`🏫 Room created: ${roomId} (session ${sessionId})`);

    socket.emit("room-created", {
      roomId: roomId,
      sessionId: sessionId,
    });
  });

  // ==========================
  // Student joins a room
  // ==========================
  socket.on("join-room", ({ roomId, name, studentCode }) => {
    const room = rooms[roomId];

    if (!room) {
      socket.emit("join-error", {
        message: "Room not found",
      });
      return;
    }

    // A student code (issued once by the teacher and re-entered every
    // class) is how we recognize "the same student" across sessions —
    // free-text names alone can't be trusted for that. If the code matches
    // the roster, the roster's saved name wins over whatever was typed, so
    // attendance records stay consistent even if a student fat-fingers their
    // name one day.
    const cleanCode = typeof studentCode === "string" && studentCode.trim() ? studentCode.trim() : null;
    const rosterMatch = cleanCode ? db.findStudentByCode(cleanCode) : null;

    const typedName = typeof name === "string" && name.trim() ? name.trim() : null;
    const displayName = rosterMatch ? rosterMatch.name : typedName;

    room.students.push(socket.id);
    room.studentNames = room.studentNames || {};
    room.studentNames[socket.id] = displayName;
    socket.join(roomId);

    // Record attendance immediately — join time is the whole point of this
    // feature, so it's written on join rather than batched at session end.
    const attendanceRowId = db.recordJoin({
      sessionId: room.sessionId,
      roomId,
      studentCode: rosterMatch ? rosterMatch.code : null,
      studentName: displayName || "Unnamed student",
    });
    room.attendanceRows[socket.id] = attendanceRowId;

    console.log(
      `👨‍🎓 Student ${socket.id} (${displayName || "no name given"}) joined ${roomId}` +
        (cleanCode ? (rosterMatch ? ` [roster: ${rosterMatch.code}]` : ` [unrecognized code: ${cleanCode}]`) : "")
    );

    // Notify student — include the recent chat log so joining mid-class
    // doesn't drop them into a conversation with zero context. Also tell
    // them whether their code matched, so the app can nudge them to check
    // it if not (rather than silently attending as "unrecognized").
    socket.emit("join-success", {
      roomId: roomId,
      chatHistory: room.chatHistory || [],
      rosterMatched: !!rosterMatch,
    });

    // Notify teacher — this is what the Android app reads to show the
    // student's real name instead of falling back to "Student N", and
    // whether that name came from a verified roster code.
    io.to(room.teacher).emit("student-joined", {
      studentId: socket.id,
      displayName: displayName,
      rosterMatched: !!rosterMatch,
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
// Chat — whole-room broadcast (no DMs yet). Messages may optionally quote an
// earlier message via replyTo — still broadcast to everyone, just rendered
// as "replying to X" so a targeted reply keeps its context.
// ==========================
socket.on("chat-message", ({ roomId, text, replyTo }) => {
  const room = rooms[roomId];
  if (!room) return;

  // Only a recognized participant of THIS room may post — guards against a
  // stale/forged socket id posting into a room it never joined.
  const isTeacher = socket.id === room.teacher;
  const isStudent = room.students.includes(socket.id);
  if (!isTeacher && !isStudent) return;

  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed) return;
  // Hard cap so one client can't push an enormous payload into memory/broadcast.
  const safeText = trimmed.slice(0, 500);

  const senderName = isTeacher
    ? "Teacher"
    : (room.studentNames && room.studentNames[socket.id]) || "Student";

  // Validate/trim the optional quoted message rather than trusting the
  // client's shape wholesale — only the fields we actually render.
  let safeReplyTo = null;
  if (replyTo && typeof replyTo === "object") {
    const replyText = typeof replyTo.text === "string" ? replyTo.text.trim().slice(0, 200) : "";
    const replySenderName = typeof replyTo.senderName === "string" ? replyTo.senderName.trim().slice(0, 40) : "";
    if (replyText && replySenderName) {
      safeReplyTo = {
        id: typeof replyTo.id === "string" ? replyTo.id : null,
        senderId: typeof replyTo.senderId === "string" ? replyTo.senderId : null,
        senderName: replySenderName,
        text: replyText,
      };
    }
  }

  const message = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    senderId: socket.id,
    senderName,
    role: isTeacher ? "teacher" : "student",
    text: safeText,
    ts: Date.now(),
    replyTo: safeReplyTo,
  };

  room.chatHistory.push(message);
  if (room.chatHistory.length > CHAT_HISTORY_LIMIT) {
    room.chatHistory.shift();
  }

  console.log(`💬 Chat [${roomId}] ${senderName}: ${safeText}`);

  // Broadcast to everyone in the room, including the sender — one source of
  // truth for message ordering/rendering instead of each client locally
  // echoing its own message differently.
  io.to(roomId).emit("chat-message", message);
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

        // Anyone still "joined" at this instant never got their own
        // disconnect event fired — close their attendance rows here so no
        // session ends with a student stuck at left_at = null.
        db.closeOpenAttendanceForSession(room.sessionId);
        db.endSession(room.sessionId);

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

      const attendanceRowId = room.attendanceRows && room.attendanceRows[socket.id];
      if (attendanceRowId) {
        db.recordLeave(attendanceRowId);
        delete room.attendanceRows[socket.id];
      }
    }
  });
});

const PORT = 3000;

server.listen(PORT, () => {
  console.log(`🚀 Server started on http://localhost:${PORT}`);
});