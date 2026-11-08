(() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const socket = io();
  const audioEl = $('#audio-el');
  const fileInput = $('#file-input');

  let session = { code: null, username: null, isHost: false };
  let state = null;

  // --- Theme Toggle ---
  const savedTheme = localStorage.getItem('musiq-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', savedTheme);

  $$('.theme-toggle-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme');
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('musiq-theme', next);
    });
  });

  // --- Create & Join Rooms ---
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

  $('#join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const username = $('#join-username').value.trim();
    const code = $('#join-code').value.trim().toUpperCase();
    if (username && code) {
      enterRoom(code, username, null);
    }
  });

  function enterRoom(code, username, hostToken) {
    socket.emit('join-room', { code, username, hostToken }, (resp) => {
      if (resp.error) {
        $('#home-error').textContent = resp.error;
        return;
      }

      session = { code, username, isHost: resp.isHost };
      state = resp.state;

      $('#home-view').classList.add('hidden');
      $('#room-view').classList.remove('hidden');
      $('#room-code-display').textContent = code;

      render();
    });
  }

  // --- File Upload ---
  $('#upload-btn').addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file || !session.code) return;

    $('#upload-status').textContent = 'Uploading...';

    const formData = new FormData();
    formData.append('file', file);
    formData.append('username', session.username);
    formData.append('displayName', file.name);

    try {
      const res = await fetch(`/api/rooms/${session.code}/upload`, {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      $('#upload-status').textContent = 'Uploaded!';
    } catch (err) {
      $('#upload-status').textContent = err.message || 'Upload failed.';
    } finally {
      fileInput.value = '';
    }
  });

  // --- Socket Sync ---
  socket.on('room-updated', (s) => { state = s; render(); });
  socket.on('queue-updated', (s) => { state = s; render(); });
  socket.on('playback-update', (s) => { state = s; render(); });

  // --- Play / Pause ---
  $('#play-pause-btn').addEventListener('click', () => {
    if (!session.isHost) return;
    if (state?.playback?.isPlaying) {
      socket.emit('playback-pause');
    } else {
      socket.emit('playback-play');
    }
  });

  // --- Render UI ---
  function render() {
    if (!state) return;

    // Render Queue
    const queueList = $('#queue-list');
    queueList.innerHTML = '';
    state.queue.forEach((track, i) => {
      const li = document.createElement('li');
      li.textContent = `${i + 1}. ${track.name} (added by ${track.addedBy})`;
      queueList.appendChild(li);
    });

    // Render Player
    const currentTrack = state.queue[state.currentIndex];
    if (currentTrack) {
      $('#track-title').textContent = currentTrack.name;
      $('#track-subtitle').textContent = `Added by ${currentTrack.addedBy}`;

      const trackUrl = `/api/rooms/${session.code}/tracks/${currentTrack.id}`;
      if (audioEl.src !== window.location.origin + trackUrl) {
        audioEl.src = trackUrl;
      }

      if (state.playback.isPlaying) {
        audioEl.play().catch(() => {});
      } else {
        audioEl.pause();
      }
    } else {
      $('#track-title').textContent = 'Nothing playing';
      $('#track-subtitle').textContent = '';
      audioEl.pause();
    }
  }

  $('#leave-btn').addEventListener('click', () => window.location.reload());
})();
