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

// Socket.io setup configured for Render proxying
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling']
});

const PORT = process.env.PORT || 3000;
const UPLOAD_ROOT = path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOAD_ROOT)) {
  fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();

function makeRoomCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
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

// REST API
app.post('/api/rooms', (req, res) => {
  const username = (req.body?.username || '').trim().slice(0, 24);
  if (!username) return res.status(400).json({ error: 'Username required.' });

  const code = makeRoomCode();
  const hostToken = uuidv4();
  const room = {
    code,
    hostToken,
    hostSocketId: null,
    users: new Map(),
    queue: [],
    currentIndex: -1,
    playback: { isPlaying: false, startedAt: null, pausedAtPositionMs: 0 },
    createdAt: Date.now(),
  };
  rooms.set(code, room);
  
  const roomDir = path.join(UPLOAD_ROOT, code);
  if (!fs.existsSync(roomDir)) fs.mkdirSync(roomDir, { recursive: true });

  res.json({ code, hostToken });
});

app.get('/api/rooms/:code', (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found.' });
  res.json({ code: room.code, memberCount: room.users.size });
});

// Multer in-memory upload handler
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const isAudio = file.mimetype.startsWith('audio/') || file.originalname.toLowerCase().endsWith('.mp3');
    cb(isAudio ? null : new Error('Only MP3 audio files are allowed'), isAudio);
  },
});

app.post('/api/rooms/:code/upload', upload.single('file'), async (req, res) => {
  const code = req.params.code.toUpperCase();
  const room = rooms.get(code);
  if (!room) return res.status(404).json({ error: 'Room not found.' });
  if (!req.file) return res.status(400).json({ error: 'No audio file uploaded.' });

  try {
    const trackId = uuidv4();
    const storedFilename = `${trackId}.mp3`;
    const roomDir = path.join(UPLOAD_ROOT, code);

    if (!fs.existsSync(roomDir)) {
      await fsp.mkdir(roomDir, { recursive: true });
    }

    await fsp.writeFile(path.join(roomDir, storedFilename), req.file.buffer);

    const username = (req.body?.username || 'Someone').trim().slice(0, 24);
    const track = {
      id: trackId,
      originalName: (req.body?.displayName || req.file.originalname).replace(/\.mp3$/i, '').slice(0, 80),
      addedBy: username,
      storedFilename,
    };

    room.queue.push(track);

    if (room.currentIndex === -1) {
      startTrackAt(room, 0);
    }

    io.to(code).emit('queue-updated', publicRoomState(room));
    io.to(code).emit('playback-update', publicRoomState(room));

    res.json({ ok: true, track: { id: track.id, name: track.originalName } });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save audio file: ' + err.message });
  }
});

app.get('/api/rooms/:code/tracks/:trackId', (req, res) => {
  const code = req.params.code.toUpperCase();
  const room = rooms.get(code);
  if (!room) return res.status(404).end();
  const track = room.queue.find(t => t.id === req.params.trackId);
  if (!track) return res.status(404).end();

  const filePath = path.join(UPLOAD_ROOT, code, track.storedFilename);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', 'audio/mpeg');
  res.sendFile(filePath, (err) => { if (err && !res.headersSent) res.status(404).end(); });
});

// Socket logic
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
    if (claimsHost) room.hostSocketId = socket.id;

    joinedCode = code;
    socket.join(code);
    room.users.set(socket.id, { username, isHost: claimsHost || room.hostSocketId === socket.id });

    cb?.({ ok: true, isHost: claimsHost || room.hostSocketId === socket.id, state: publicRoomState(room) });
    io.to(code).emit('room-updated', publicRoomState(room));
  });

  socket.on('playback-play', () => {
    const room = rooms.get(joinedCode);
    if (!room || room.hostSocketId !== socket.id) return;
    if (room.currentIndex === -1 && room.queue.length > 0) room.currentIndex = 0;
    if (room.currentIndex === -1) return;
    room.playback.isPlaying = true;
    room.playback.startedAt = Date.now() - room.playback.pausedAtPositionMs;
    io.to(joinedCode).emit('playback-update', publicRoomState(room));
  });

  socket.on('playback-pause', () => {
    const room = rooms.get(joinedCode);
    if (!room || room.hostSocketId !== socket.id) return;
    if (room.playback.isPlaying) {
      room.playback.pausedAtPositionMs = Date.now() - room.playback.startedAt;
    }
    room.playback.isPlaying = false;
    io.to(joinedCode).emit('playback-update', publicRoomState(room));
  });

  socket.on('playback-seek', (positionMs) => {
    const room = rooms.get(joinedCode);
    if (!room || room.hostSocketId !== socket.id) return;
    positionMs = Math.max(0, Number(positionMs) || 0);
    room.playback.pausedAtPositionMs = positionMs;
    room.playback.startedAt = Date.now() - positionMs;
    io.to(joinedCode).emit('playback-update', publicRoomState(room));
  });

  socket.on('playback-skip', () => {
    const room = rooms.get(joinedCode);
    if (!room || room.hostSocketId !== socket.id) return;
    advance(room, room.currentIndex + 1);
  });

  socket.on('track-ended', () => {
    const room = rooms.get(joinedCode);
    if (!room || room.currentIndex === -1) return;
    advance(room, room.currentIndex + 1);
  });

  function advance(room, toIndex) {
    if (toIndex >= room.queue.length) {
      room.currentIndex = -1;
      room.playback = { isPlaying: false, startedAt: null, pausedAtPositionMs: 0 };
    } else {
      startTrackAt(room, toIndex);
    }
    io.to(room.code).emit('playback-update', publicRoomState(room));
  }

  socket.on('disconnect', () => {
    if (!joinedCode) return;
    const room = rooms.get(joinedCode);
    if (!room) return;
    room.users.delete(socket.id);
    io.to(joinedCode).emit('room-updated', publicRoomState(room));
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});
