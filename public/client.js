(() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const homeView = $('#home-view');
  const roomView = $('#room-view');
  const fileInput = $('#file-input');
  const audioEl = $('#audio-el');
  const socket = io();

  let session = { code: null, username: null, isHost: false };
  let state = null;
  let loadedTrackId = null;

  // Theme Switcher
  const savedTheme = localStorage.getItem('musiq-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', savedTheme);

  document.addEventListener('click', (e) => {
    if (e.target.closest('.theme-toggle-btn')) {
      const current = document.documentElement.getAttribute('data-theme');
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('musiq-theme', next);
    }
    if (e.target.closest('.trigger-upload-btn')) {
      fileInput.click();
    }
  });

  // Create Room
  $('#create-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('#create-username').value.trim();
    if (!username) return;

    try {
      const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      enterRoom(data.code, username, data.hostToken);
    } catch (err) {
      $('#home-error').textContent = err.message;
    }
  });

  // Join Room
  $('#join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const username = $('#join-username').value.trim();
    const code = $('#join-code').value.trim().toUpperCase();
    if (username && code) enterRoom(code, username, null);
  });

  function enterRoom(code, username, hostToken) {
    socket.emit('join-room', { code, username, hostToken }, (resp) => {
      if (resp?.error) {
        $('#home-error').textContent = resp.error;
        return;
      }
      session = { code, username, isHost: resp.isHost };
      state = resp.state;

      homeView.classList.add('hidden');
      roomView.classList.remove('hidden');
      $('#room-code-display').textContent = code;
      render();
    });
  }

  // Upload Song
  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file || !session.code) return;

    $('#upload-status').textContent = 'Uploading song...';
    const form = new FormData();
    form.append('file', file);
    form.append('username', session.username);
    form.append('displayName', file.name.replace(/\.mp3$/i, ''));

    try {
      const res = await fetch(`/api/rooms/${session.code}/upload`, { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      $('#upload-status').textContent = `Added "${data.track.name}"`;
    } catch (err) {
      $('#upload-status').textContent = err.message || 'Upload failed';
    } finally {
      fileInput.value = '';
      setTimeout(() => { $('#upload-status').textContent = ''; }, 3000);
    }
  });

  // Socket Handlers
  socket.on('room-updated', (s) => { state = s; render(); });
  socket.on('queue-updated', (s) => { state = s; render(); });
  socket.on('playback-update', (s) => { state = s; render(); });

  function render() {
    if (!state) return;

    // Queue Render
    const list = $('#queue-list');
    list.innerHTML = '';
    state.queue.forEach((track, idx) => {
      const li = document.createElement('li');
      li.textContent = `${idx + 1}. ${track.name} (by ${track.addedBy})`;
      list.appendChild(li);
    });

    // Playback Render
    const track = state.queue[state.currentIndex];
    if (track) {
      $('#now-playing-empty').classList.add('hidden');
      $('#now-playing-content').classList.remove('hidden');
      $('#track-title').textContent = track.name;
      $('#track-added-by').textContent = `added by ${track.addedBy}`;
      $('#host-controls').classList.toggle('hidden', !session.isHost);

      if (loadedTrackId !== track.id) {
        loadedTrackId = track.id;
        audioEl.src = `/api/rooms/${session.code}/tracks/${track.id}`;
      }

      if (state.playback.isPlaying) {
        audioEl.play().catch(() => {});
      } else {
        audioEl.pause();
      }
    } else {
      $('#now-playing-empty').classList.remove('hidden');
      $('#now-playing-content').classList.add('hidden');
      audioEl.pause();
    }
  }

  $('#play-pause-btn').addEventListener('click', () => {
    if (!session.isHost) return;
    if (state.playback.isPlaying) socket.emit('playback-pause');
    else socket.emit('playback-play');
  });

  $('#skip-btn').addEventListener('click', () => {
    if (session.isHost) socket.emit('playback-skip');
  });

  $('#leave-btn').addEventListener('click', () => window.location.reload());
})();
