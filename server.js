const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

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
    users: Array.from(room.users.values()),
    queue: room.queue,
    currentIndex: room.currentIndex,
    playback: room.playback,
    serverTime: Date.now(),
  };
}

// Create Room Endpoint
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
  };

  rooms.set(code, room);
  fs.mkdirSync(path.join(UPLOAD_ROOT, code), { recursive: true });
  res.json({ code, hostToken });
});

// Upload Track Endpoint
const upload = multer({ storage: multer.memoryStorage() });

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
      fs.mkdirSync(roomDir, { recursive: true });
    }

    fs.writeFileSync(path.join(roomDir, storedFilename), req.file.buffer);

    const username = (req.body?.username || 'Someone').trim().slice(0, 24);
    const track = {
      id: trackId,
      name: (req.body?.displayName || req.file.originalname).replace(/\.mp3$/i, '').slice(0, 80),
      addedBy: username,
      storedFilename,
    };

    room.queue.push(track);
    if (room.currentIndex === -1) {
      room.currentIndex = 0;
      room.playback.isPlaying = true;
      room.playback.startedAt = Date.now();
      room.playback.pausedAtPositionMs = 0;
    }

    io.to(code).emit('queue-updated', publicRoomState(room));
    io.to(code).emit('playback-update', publicRoomState(room));

    res.json({ ok: true, track });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save audio file.' });
  }
});

// Stream Track Endpoint
app.get('/api/rooms/:code/tracks/:trackId', (req, res) => {
  const code = req.params.code.toUpperCase();
  const room = rooms.get(code);
  if (!room) return res.status(404).end();

  const track = room.queue.find((t) => t.id === req.params.trackId);
  if (!track) return res.status(404).end();

  const filePath = path.join(UPLOAD_ROOT, code, track.storedFilename);
  res.sendFile(filePath);
});

// Socket.io Events
io.on('connection', (socket) => {
  let joinedCode = null;

  socket.on('join-room', ({ code, username, hostToken }, cb) => {
    code = (code || '').toUpperCase().trim();
    username = (username || '').trim().slice(0, 24);

    const room = rooms.get(code);
    if (!room) return cb?.({ error: 'Room not found.' });
    if (!username) return cb?.({ error: 'Username required.' });

    const isHost = Boolean(hostToken && hostToken === room.hostToken);
    if (isHost) room.hostSocketId = socket.id;

    joinedCode = code;
    socket.join(code);
    room.users.set(socket.id, { username, isHost });

    cb?.({ ok: true, isHost, state: publicRoomState(room) });
    io.to(code).emit('room-updated', publicRoomState(room));
  });

  socket.on('playback-play', () => {
    const room = rooms.get(joinedCode);
    if (!room || room.hostSocketId !== socket.id) return;
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

  socket.on('disconnect', () => {
    if (!joinedCode) return;
    const room = rooms.get(joinedCode);
    if (!room) return;
    room.users.delete(socket.id);
    io.to(joinedCode).emit('room-updated', publicRoomState(room));
  });
});

server.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
