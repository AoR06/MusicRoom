const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const UPLOAD_ROOT = path.join(__dirname, 'uploads');
const HOST_GRACE_MS = 30 * 1000;        // time a host has to reconnect before losing host status / room closing
const INACTIVITY_LIMIT_MS = 2 * 60 * 60 * 1000; // 2 hours
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

if (!fs.existsSync(UPLOAD_ROOT)) fs.mkdirSync(UPLOAD_ROOT);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// In-memory room store
// ---------------------------------------------------------------------------
// rooms[code] = {
//   code, hostToken, hostSocketId, hostDisconnectedAt,
//   users: Map(socketId -> { username, isHost }),
//   queue: [{ id, originalName, addedBy, sizeBytes }],
//   currentIndex: -1,
//   playback: { isPlaying: false, startedAt: null, pausedAtPositionMs: 0 },
//   createdAt, lastActivity
// }
const rooms = new Map();

function makeRoomCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  let code;
  do {
    code = Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function publicRoomState(room) {
  return {
    code: room.code,
    users: Array.from(room.users.values()).map(u => ({ username: u.username, isHost: u.isHost })),
    queue: room.queue.map(t => ({ id: t.id, name: t.originalName, addedBy: t.addedBy })),
    currentIndex: room.currentIndex,
    playback: room.playback,
    serverTime: Date.now(),
  };
}

function touch(room) {
  room.lastActivity = Date.now();
}

function currentTrack(room) {
  if (room.currentIndex < 0 || room.currentIndex >= room.queue.length) return null;
  return room.queue[room.currentIndex];
}

function startTrackAt(room, index) {
  room.currentIndex = index;
  room.playback.isPlaying = index >= 0;
  room.playback.startedAt = Date.now();
  room.playback.pausedAtPositionMs = 0;
}

async function deleteRoom(code, reason) {
  const room = rooms.get(code);
  if (!room) return;
  rooms.delete(code);
  io.to(code).emit('room-closed', { reason });
  const dir = path.join(UPLOAD_ROOT, code);
  try {
    await fsp.rm(dir, { recursive: true, force: true });
  } catch (_) { /* ignore */ }
}

// Periodic sweep for abandoned / inactive rooms
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    const hostGoneTooLong = room.hostDisconnectedAt && (now - room.hostDisconnectedAt > HOST_GRACE_MS);
    const inactiveTooLong = (now - room.lastActivity) > INACTIVITY_LIMIT_MS;
    if (hostGoneTooLong || inactiveTooLong) {
      deleteRoom(code, hostGoneTooLong ? 'host-left' : 'inactive');
    }
  }
}, SWEEP_INTERVAL_MS);

// Also check host-grace expiry more frequently so rooms close promptly after host leaves
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (room.hostDisconnectedAt && (now - room.hostDisconnectedAt > HOST_GRACE_MS)) {
      deleteRoom(code, 'host-left');
    }
  }
}, 5000);

// ---------------------------------------------------------------------------
// REST: create room, upload track, stream track
// ---------------------------------------------------------------------------
app.post('/api/rooms', (req, res) => {
  const username = (req.body?.username || '').trim().slice(0, 24);
  if (!username) return res.status(400).json({ error: 'Username required.' });

  const code = makeRoomCode();
  const hostToken = uuidv4();
  const room = {
    code,
    hostToken,
    hostSocketId: null,
    hostDisconnectedAt: null,
    users: new Map(),
    queue: [],
    currentIndex: -1,
    playback: { isPlaying: false, startedAt: null, pausedAtPositionMs: 0 },
    createdAt: Date.now(),
    lastActivity: Date.now(),
  };
  rooms.set(code, room);
  fs.mkdirSync(path.join(UPLOAD_ROOT, code), { recursive: true });
  res.json({ code, hostToken });
});

app.get('/api/rooms/:code', (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found.' });
  res.json({ code: room.code, memberCount: room.users.size });
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const code = req.params.code.toUpperCase();
    const room = rooms.get(code);
    if (!room) return cb(new Error('Room not found'));
    cb(null, path.join(UPLOAD_ROOT, code));
  },
  filename: (req, file, cb) => cb(null, `${uuidv4()}.mp3`),
});
const upload = multer({
  storage,
  limits: { fileSize: 40 * 1024 * 1024 }, // 40MB per track
  fileFilter: (req, file, cb) => {
    const okType = file.mimetype === 'audio/mpeg' || file.originalname.toLowerCase().endsWith('.mp3');
    cb(okType ? null : new Error('Only .mp3 files are allowed'), okType);
  },
});

app.post('/api/rooms/:code/upload', (req, res) => {
  const code = req.params.code.toUpperCase();
  const room = rooms.get(code);
  if (!room) return res.status(404).json({ error: 'Room not found.' });

  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    const username = (req.body?.username || 'Someone').trim().slice(0, 24);
    const track = {
      id: path.basename(req.file.filename, '.mp3'),
      originalName: (req.body?.displayName || req.file.originalname).slice(0, 80),
      addedBy: username,
      storedFilename: req.file.filename,
    };
    room.queue.push(track);
    touch(room);

    const wasEmpty = room.currentIndex === -1;
    if (wasEmpty) {
      startTrackAt(room, room.queue.length - 1);
    }

    io.to(code).emit('queue-updated', publicRoomState(room));
    res.json({ ok: true, track: { id: track.id, name: track.originalName } });
  });
});

app.get('/api/rooms/:code/tracks/:trackId', (req, res) => {
  const code = req.params.code.toUpperCase();
  const room = rooms.get(code);
  if (!room) return res.status(404).end();
  const track = room.queue.find(t => t.id === req.params.trackId);
  if (!track) return res.status(404).end();
  const filePath = path.join(UPLOAD_ROOT, code, track.storedFilename);
  res.setHeader('Accept-Ranges', 'bytes');
  res.sendFile(filePath, (err) => { if (err && !res.headersSent) res.status(404).end(); });
});

// ---------------------------------------------------------------------------
// Socket.io: room membership, host-only playback control, clock sync
// ---------------------------------------------------------------------------
function isHost(room, socketId) {
  return room.hostSocketId === socketId;
}

io.on('connection', (socket) => {
  let joinedCode = null;

  socket.on('time-sync', (clientTime) => {
    socket.emit('time-sync-reply', { clientTime, serverTime: Date.now() });
  });

  socket.on('join-room', ({ code, username, hostToken }, cb) => {
    code = (code || '').toUpperCase().trim();
    username = (username || '').trim().slice(0, 24);
    const room = rooms.get(code);
    if (!room) return cb?.({ error: 'Room not found.' });
    if (!username) return cb?.({ error: 'Username required.' });

    const claimsHost = Boolean(hostToken && hostToken === room.hostToken);
    if (claimsHost) {
      room.hostSocketId = socket.id;
      room.hostDisconnectedAt = null;
    }

    joinedCode = code;
    socket.join(code);
    room.users.set(socket.id, { username, isHost: claimsHost || isHost(room, socket.id) });
    touch(room);

    cb?.({ ok: true, isHost: claimsHost, state: publicRoomState(room) });
    socket.to(code).emit('room-updated', publicRoomState(room));
  });

  function requireHost(room) {
    return room && isHost(room, socket.id);
  }

  socket.on('playback-play', () => {
    const room = rooms.get(joinedCode);
    if (!requireHost(room)) return;
    if (room.currentIndex === -1 && room.queue.length > 0) room.currentIndex = 0;
    if (room.currentIndex === -1) return;
    room.playback.isPlaying = true;
    room.playback.startedAt = Date.now() - room.playback.pausedAtPositionMs;
    touch(room);
    io.to(joinedCode).emit('playback-update', publicRoomState(room));
  });

  socket.on('playback-pause', () => {
    const room = rooms.get(joinedCode);
    if (!requireHost(room)) return;
    if (room.playback.isPlaying) {
      room.playback.pausedAtPositionMs = Date.now() - room.playback.startedAt;
    }
    room.playback.isPlaying = false;
    touch(room);
    io.to(joinedCode).emit('playback-update', publicRoomState(room));
  });

  socket.on('playback-seek', (positionMs) => {
    const room = rooms.get(joinedCode);
    if (!requireHost(room)) return;
    positionMs = Math.max(0, Number(positionMs) || 0);
    room.playback.pausedAtPositionMs = positionMs;
    room.playback.startedAt = Date.now() - positionMs;
    touch(room);
    io.to(joinedCode).emit('playback-update', publicRoomState(room));
  });

  function advance(room, toIndex) {
    if (toIndex >= room.queue.length) {
      room.currentIndex = -1;
      room.playback = { isPlaying: false, startedAt: null, pausedAtPositionMs: 0 };
    } else {
      startTrackAt(room, toIndex);
    }
    touch(room);
    io.to(room.code).emit('playback-update', publicRoomState(room));
  }

  socket.on('playback-skip', () => {
    const room = rooms.get(joinedCode);
    if (!requireHost(room)) return;
    advance(room, room.currentIndex + 1);
  });

  socket.on('track-ended', () => {
    const room = rooms.get(joinedCode);
    if (!room) return;
    // Any client can report end-of-track (they're all listening), but only advance once per track.
    if (room.currentIndex === -1) return;
    advance(room, room.currentIndex + 1);
  });

  socket.on('remove-song', (trackId) => {
    const room = rooms.get(joinedCode);
    if (!requireHost(room)) return;
    const idx = room.queue.findIndex(t => t.id === trackId);
    if (idx === -1) return;
    const removingCurrent = idx === room.currentIndex;
    room.queue.splice(idx, 1);
    fsp.unlink(path.join(UPLOAD_ROOT, room.code, `${trackId}.mp3`)).catch(() => {});
    if (idx < room.currentIndex) room.currentIndex -= 1;
    if (removingCurrent) {
      if (room.currentIndex >= room.queue.length) room.currentIndex = -1;
      if (room.currentIndex === -1) {
        room.playback = { isPlaying: false, startedAt: null, pausedAtPositionMs: 0 };
      } else {
        startTrackAt(room, room.currentIndex);
      }
    }
    touch(room);
    io.to(room.code).emit('queue-updated', publicRoomState(room));
  });

  socket.on('reorder-queue', (orderedIds) => {
    const room = rooms.get(joinedCode);
    if (!requireHost(room)) return;
    const currentId = currentTrack(room)?.id;
    const byId = new Map(room.queue.map(t => [t.id, t]));
    const reordered = orderedIds.map(id => byId.get(id)).filter(Boolean);
    if (reordered.length !== room.queue.length) return; // malformed, ignore
    room.queue = reordered;
    room.currentIndex = currentId ? room.queue.findIndex(t => t.id === currentId) : -1;
    touch(room);
    io.to(room.code).emit('queue-updated', publicRoomState(room));
  });

  socket.on('leave-room', () => handleLeave());

  socket.on('disconnect', () => handleLeave());

  function handleLeave() {
    if (!joinedCode) return;
    const room = rooms.get(joinedCode);
    if (!room) return;
    room.users.delete(socket.id);
    if (isHost(room, socket.id)) {
      room.hostDisconnectedAt = Date.now(); // grace period for reconnect before auto-close
    }
    touch(room);
    if (room.users.size === 0) {
      // Nobody left at all — no need to wait for the sweep, but still respect host grace period
      if (!room.hostDisconnectedAt) deleteRoom(room.code, 'empty');
    } else {
      io.to(joinedCode).emit('room-updated', publicRoomState(room));
    }
    joinedCode = null;
  }
});

server.listen(PORT, () => {
  console.log(`Music room server listening on http://localhost:${PORT}`);
});
