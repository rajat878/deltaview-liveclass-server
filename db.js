const path = require("path");
const Database = require("better-sqlite3");

// Single SQLite file living next to the server code. This is intentionally
// simple (no migrations framework) — fine for one teacher's classes, and
// easy to swap out later if this ever needs to scale to many institutions.
const db = new Database(path.join(__dirname, "liveclass.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS students (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    student_code TEXT,       -- NULL if the student joined without a roster code
    student_name TEXT NOT NULL,
    joined_at INTEGER NOT NULL,
    left_at INTEGER,
    duration_seconds INTEGER,
    FOREIGN KEY (session_id) REFERENCES sessions(session_id)
  );

  CREATE INDEX IF NOT EXISTS idx_attendance_session ON attendance(session_id);
`);

// ---------- Roster ----------

function addStudent(code, name) {
  db.prepare(
    `INSERT INTO students (code, name, created_at) VALUES (?, ?, ?)
     ON CONFLICT(code) DO UPDATE SET name = excluded.name`
  ).run(code, name, Date.now());
  return { code, name };
}

function removeStudent(code) {
  const info = db.prepare(`DELETE FROM students WHERE code = ?`).run(code);
  return info.changes > 0;
}

function getRoster() {
  return db.prepare(`SELECT code, name, created_at FROM students ORDER BY name COLLATE NOCASE`).all();
}

function findStudentByCode(code) {
  if (!code) return null;
  return db.prepare(`SELECT code, name FROM students WHERE code = ?`).get(code) || null;
}

// ---------- Sessions ----------

function startSession(sessionId, roomId) {
  db.prepare(
    `INSERT INTO sessions (session_id, room_id, started_at) VALUES (?, ?, ?)`
  ).run(sessionId, roomId, Date.now());
}

function endSession(sessionId) {
  db.prepare(`UPDATE sessions SET ended_at = ? WHERE session_id = ?`).run(Date.now(), sessionId);
}

function listSessions() {
  return db
    .prepare(
      `SELECT s.session_id, s.room_id, s.started_at, s.ended_at,
              COUNT(a.id) AS attendee_count
       FROM sessions s
       LEFT JOIN attendance a ON a.session_id = s.session_id
       GROUP BY s.session_id
       ORDER BY s.started_at DESC`
    )
    .all();
}

// ---------- Attendance ----------

// Returns the new row id so the caller (socket layer) can remember it and
// close it out later without a second lookup.
function recordJoin({ sessionId, roomId, studentCode, studentName }) {
  const info = db
    .prepare(
      `INSERT INTO attendance (session_id, room_id, student_code, student_name, joined_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(sessionId, roomId, studentCode || null, studentName, Date.now());
  return info.lastInsertRowid;
}

function recordLeave(attendanceRowId) {
  const row = db.prepare(`SELECT joined_at FROM attendance WHERE id = ?`).get(attendanceRowId);
  if (!row) return;
  const leftAt = Date.now();
  const durationSeconds = Math.max(0, Math.round((leftAt - row.joined_at) / 1000));
  db.prepare(
    `UPDATE attendance SET left_at = ?, duration_seconds = ? WHERE id = ?`
  ).run(leftAt, durationSeconds, attendanceRowId);
}

// Called when a whole session ends (teacher closes the room) so any student
// who never got a clean disconnect event still gets a left_at recorded.
function closeOpenAttendanceForSession(sessionId) {
  const openRows = db
    .prepare(`SELECT id FROM attendance WHERE session_id = ? AND left_at IS NULL`)
    .all(sessionId);
  for (const row of openRows) {
    recordLeave(row.id);
  }
}

function getSessionAttendance(sessionId) {
  return db
    .prepare(
      `SELECT id, student_code, student_name, joined_at, left_at, duration_seconds
       FROM attendance WHERE session_id = ? ORDER BY joined_at ASC`
    )
    .all(sessionId);
}

module.exports = {
  addStudent,
  removeStudent,
  getRoster,
  findStudentByCode,
  startSession,
  endSession,
  listSessions,
  recordJoin,
  recordLeave,
  closeOpenAttendanceForSession,
  getSessionAttendance,
};