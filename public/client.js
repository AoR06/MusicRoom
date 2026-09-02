(() => {
  const $ = (sel) => document.querySelector(sel);

  const homeView = $('#home-view');
  const roomView = $('#room-view');
  const homeError = $('#home-error');

  const audioEl = $('#audio-el');
  const socket = io();

  // ---------------------------------------------------------------
  // Clock sync: estimate offset between our clock and the server's,
  // so every client can compute "what position should be playing
  // right now" from the same server-issued timestamps.
  // ---------------------------------------------------------------
  let clockOffset = 0; // serverTime ≈ Date.now() + clockOffset

  function syncClock(rounds = 5) {
    let best = null;
    let done = 0;
    return new Promise((resolve) => {
      function ping() {
        const t0 = Date.now();
        socket.emit('time-sync', t0);
      }
      socket.on('time-sync-reply', ({ clientTime, serverTime }) => {
        const t3 = Date.now();
        const rtt = t3 - clientTime;
        const offset = serverTime - (clientTime + t3) / 2;
        if (best === null || rtt < best.rtt) best = { rtt, offset };
        done += 1;
        if (done >= rounds) {
          clockOffset = best.offset;
          resolve();
        } else {
          setTimeout(ping, 80);
        }
      });
      ping();
    });
  }

  function serverNow() { return Date.now() + clockOffset; }

  // ---------------------------------------------------------------
  // Session / room state
  // ---------------------------------------------------------------
  let session = { code: null, username: null, hostToken: null, isHost: false };
  let state = null; // last known publicRoomState from server
  let loadedTrackId = null;
  let resyncTimer = null;

  function showError(msg) { homeError.textContent = msg || ''; }

  // ---------------------------------------------------------------
  // Home view: create / join
  // ---------------------------------------------------------------
  $('#create-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    showError('');
    const username = $('#create-username').value.trim();
    if (!username) return;
    try {
      const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not create room.');
      await enterRoom({ code: data.code, username, hostToken: data.hostToken });
    } catch (err) {
      showError(err.message);
    }
  });

  $('#join-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    showError('');
    const username = $('#join-username').value.trim();
    const code = $('#join-code').value.trim().toUpperCase();
    if (!username || !code) return;
    await enterRoom({ code, username, hostToken: null });
  });

  async function enterRoom({ code, username, hostToken }) {
    await syncClock();
    socket.emit('join-room', { code, username, hostToken }, (resp) => {
      if (resp?.error) { showError(resp.error); return; }
      session = { code, username, hostToken, isHost: resp.isHost };
      state = resp.state;
      homeView.classList.add('hidden');
      roomView.classList.remove('hidden');
      $('#room-code-display').textContent = code;
      renderAll();
    });
  }

  // ---------------------------------------------------------------
  // Socket event handlers (server -> client)
  // ---------------------------------------------------------------
  socket.on('room-updated', (s) => { state = s; renderPeople(); renderQueue(); });
  socket.on('queue-updated', (s) => { state = s; renderQueue(); renderNowPlaying(); });
  socket.on('playback-update', (s) => { state = s; renderNowPlaying(); });
  socket.on('room-closed', ({ reason }) => {
    alert(reason === 'host-left'
      ? 'The host left and the room has closed.'
      : 'This room closed due to inactivity.');
    window.location.reload();
  });

  // ---------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------
  function renderAll() { renderPeople(); renderQueue(); renderNowPlaying(); }

  function renderPeople() {
    const wrap = $('#people-pills');
    wrap.innerHTML = '';
    state.users.forEach(u => {
      const pill = document.createElement('span');
      pill.className = 'person-pill' + (u.isHost ? ' is-host' : '');
      pill.innerHTML = (u.isHost ? '<span class="dot"></span>' : '') + escapeHtml(u.username);
      wrap.appendChild(pill);
    });
    $('#host-badge').textContent = session.isHost ? 'You are hosting' : '';
  }

  function renderQueue() {
    const list = $('#queue-list');
    const empty = $('#queue-empty');
    list.innerHTML = '';
    if (state.queue.length === 0) {
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');
    state.queue.forEach((track, i) => {
      const li = document.createElement('li');
      li.className = 'queue-item' + (i === state.currentIndex ? ' is-current' : '');
      li.innerHTML = `
        <span class="queue-index">${i + 1}</span>
        <span class="queue-meta">
          <div class="queue-name">${escapeHtml(track.name)}</div>
          <div class="queue-added-by">added by ${escapeHtml(track.addedBy)}</div>
        </span>
      `;
      if (session.isHost) {
        const removeBtn = document.createElement('button');
        removeBtn.className = 'queue-remove';
        removeBtn.setAttribute('aria-label', 'Remove song');
        removeBtn.textContent = '×';
        removeBtn.addEventListener('click', () => socket.emit('remove-song', track.id));
        li.appendChild(removeBtn);
      }
      list.appendChild(li);
    });
  }

  function currentTrackMeta() {
    if (!state || state.currentIndex < 0) return null;
    return state.queue[state.currentIndex] || null;
  }

  function renderNowPlaying() {
    const track = currentTrackMeta();
    const emptyEl = $('#now-playing-empty');
    const contentEl = $('#now-playing-content');

    if (!track) {
      emptyEl.classList.remove('hidden');
      contentEl.classList.add('hidden');
      audioEl.pause();
      audioEl.removeAttribute('src');
      loadedTrackId = null;
      return;
    }
    emptyEl.classList.add('hidden');
    contentEl.classList.remove('hidden');

    $('#track-title').textContent = track.name;
    $('#track-added-by').textContent = `added by ${track.addedBy}`;

    $('#host-controls').classList.toggle('hidden', !session.isHost);
    $('#listener-note').classList.toggle('hidden', session.isHost);

    if (loadedTrackId !== track.id) {
      loadedTrackId = track.id;
      audioEl.src = `/api/rooms/${session.code}/tracks/${track.id}`;
    }

    applyPlaybackState();
    updatePlayPauseIcon();
    startResyncLoop();
  }

  function updatePlayPauseIcon() {
    const playing = state.playback.isPlaying;
    $('#icon-play').classList.toggle('hidden', playing);
    $('#icon-pause').classList.toggle('hidden', !playing);
  }

  // ---------------------------------------------------------------
  // Playback sync: compute the position the server thinks we should
  // be at, and correct our local <audio> element toward it.
  // ---------------------------------------------------------------
  function expectedPositionMs() {
    const pb = state.playback;
    if (!pb.startedAt) return 0;
    if (pb.isPlaying) return serverNow() - pb.startedAt;
    return pb.pausedAtPositionMs;
  }

  const enableAudioBtn = $('#enable-audio-btn');

  function applyPlaybackState() {
    const targetSec = Math.max(0, expectedPositionMs() / 1000);
    const drift = Math.abs(audioEl.currentTime - targetSec);
    if (drift > 0.35 || Number.isNaN(audioEl.currentTime)) {
      audioEl.currentTime = targetSec;
    }
    if (state.playback.isPlaying) {
      audioEl.play().then(() => {
        enableAudioBtn.classList.add('hidden');
      }).catch(() => {
        // Mobile browsers block audio that wasn't started by a direct tap.
        // Surface a one-tap button so the listener can unlock it themselves.
        enableAudioBtn.classList.remove('hidden');
      });
    } else {
      audioEl.pause();
    }
  }

  enableAudioBtn.addEventListener('click', () => {
    audioEl.play().then(() => enableAudioBtn.classList.add('hidden')).catch(() => {});
  });

  function startResyncLoop() {
    if (resyncTimer) clearInterval(resyncTimer);
    resyncTimer = setInterval(() => {
      if (!state || state.currentIndex < 0) return;
      applyPlaybackState();
    }, 2500);
  }

  audioEl.addEventListener('timeupdate', () => {
    if (!state) return;
    $('#time-current').textContent = formatTime(audioEl.currentTime);
    if (!Number.isNaN(audioEl.duration)) $('#time-total').textContent = formatTime(audioEl.duration);
    const pct = audioEl.duration ? (audioEl.currentTime / audioEl.duration) * 100 : 0;
    $('#progress-fill').style.width = `${pct}%`;
  });

  audioEl.addEventListener('ended', () => {
    socket.emit('track-ended');
  });

  function formatTime(sec) {
    if (Number.isNaN(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  // ---------------------------------------------------------------
  // Host transport controls
  // ---------------------------------------------------------------
  $('#play-pause-btn').addEventListener('click', () => {
    if (!session.isHost) return;
    if (state.playback.isPlaying) socket.emit('playback-pause');
    else socket.emit('playback-play');
  });

  $('#skip-btn').addEventListener('click', () => {
    if (session.isHost) socket.emit('playback-skip');
  });

  $('#progress-track').addEventListener('click', (e) => {
    if (!session.isHost || !audioEl.duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    const positionMs = Math.max(0, pct * audioEl.duration * 1000);
    socket.emit('playback-seek', positionMs);
  });

  // ---------------------------------------------------------------
  // Add song
  // ---------------------------------------------------------------
  $('#file-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const statusEl = $('#upload-status');
    statusEl.textContent = `Uploading ${file.name}…`;
    const form = new FormData();
    form.append('file', file);
    form.append('username', session.username);
    form.append('displayName', file.name.replace(/\.mp3$/i, ''));
    try {
      const res = await fetch(`/api/rooms/${session.code}/upload`, { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed.');
      statusEl.textContent = `Added "${data.track.name}" to the queue.`;
    } catch (err) {
      statusEl.textContent = err.message;
    } finally {
      e.target.value = '';
      setTimeout(() => { statusEl.textContent = ''; }, 4000);
    }
  });

  // ---------------------------------------------------------------
  $('#leave-btn').addEventListener('click', () => {
    socket.emit('leave-room');
    window.location.reload();
  });

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
})();
