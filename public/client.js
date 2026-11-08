(() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const homeView = $('#home-view');
  const roomView = $('#room-view');
  const homeError = $('#home-error');
  const fileInput = $('#file-input');

  const audioEl = $('#audio-el');
  const socket = io();

  // ---------------------------------------------------------------
  // Theme Switching (Dark / Light)
  // ---------------------------------------------------------------
  const savedTheme = localStorage.getItem('musiq-theme') || 'dark';
  applyTheme(savedTheme);

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('musiq-theme', theme);

    $$('.theme-toggle-btn').forEach(btn => {
      const sun = btn.querySelector('.sun-icon');
      const moon = btn.querySelector('.moon-icon');
      if (theme === 'dark') {
        sun?.classList.remove('hidden');
        moon?.classList.add('hidden');
      } else {
        sun?.classList.add('hidden');
        moon?.classList.remove('hidden');
      }
    });
  }

  function toggleTheme() {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    applyTheme(isDark ? 'light' : 'dark');
  }

  document.addEventListener('click', (e) => {
    const toggleBtn = e.target.closest('.theme-toggle-btn');
    if (toggleBtn) {
      e.preventDefault();
      toggleTheme();
    }
  });

  // Global handler for all upload button triggers
  document.addEventListener('click', (e) => {
    if (e.target.closest('.trigger-upload-btn')) {
      fileInput.click();
    }
  });

  // ---------------------------------------------------------------
  // Fast Background Clock Synchronization
  // ---------------------------------------------------------------
  let clockOffset = 0;

  function syncClock(rounds = 3) {
    let best = null;
    let done = 0;
    return new Promise((resolve) => {
      function ping() {
        const t0 = Date.now();
        socket.emit('time-sync', t0);
      }
      const handler = ({ clientTime, serverTime }) => {
        const t3 = Date.now();
        const rtt = t3 - clientTime;
        const offset = serverTime - (clientTime + t3) / 2;
        if (best === null || rtt < best.rtt) best = { rtt, offset };
        done += 1;
        if (done >= rounds) {
          socket.off('time-sync-reply', handler);
          clockOffset = best.offset;
          resolve();
        } else {
          setTimeout(ping, 20);
        }
      };
      socket.on('time-sync-reply', handler);
      ping();
    });
  }

  function serverNow() { return Date.now() + clockOffset; }

  // ---------------------------------------------------------------
  // Session & Room State
  // ---------------------------------------------------------------
  let session = { code: null, username: null, hostToken: null, isHost: false };
  let state = null;
  let loadedTrackId = null;
  let resyncTimer = null;

  function showError(msg) { homeError.textContent = msg || ''; }

  // ---------------------------------------------------------------
  // Fast Room Create & Join Handlers
  // ---------------------------------------------------------------
  $('#create-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    showError('');
    const username = $('#create-username').value.trim();
    if (!username) return;

    const btn = $('#create-btn');
    btn.disabled = true;
    btn.textContent = 'Creating...';

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
    } finally {
      btn.disabled = false;
      btn.textContent = '+ Create Room';
    }
  });

  $('#join-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    showError('');
    const username = $('#join-username').value.trim();
    const code = $('#join-code').value.trim().toUpperCase();
    if (!username || !code) return;

    const btn = $('#join-btn');
    btn.disabled = true;
    btn.textContent = 'Joining...';

    try {
      await enterRoom({ code, username, hostToken: null });
    } catch (err) {
      showError(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Join Room';
    }
  });

  async function enterRoom({ code, username, hostToken }) {
    syncClock();

    return new Promise((resolve, reject) => {
      socket.emit('join-room', { code, username, hostToken }, (resp) => {
        if (resp?.error) {
          reject(new Error(resp.error));
          return;
        }
        session = { code, username, hostToken, isHost: resp.isHost };
        state = resp.state;
        homeView.classList.add('hidden');
        roomView.classList.remove('hidden');
        $('#room-code-display').textContent = code;
        renderAll();
        resolve();
      });
    });
  }

  // Copy Code & Share Links
  $('#copy-code-btn').addEventListener('click', () => {
    if (session.code) {
      navigator.clipboard.writeText(session.code);
      alert(`Copied room code: ${session.code}`);
    }
  });

  $('#share-room-btn').addEventListener('click', () => {
    if (session.code) {
      navigator.clipboard.writeText(`Join my room on Musiq! Room Code: ${session.code}`);
      alert(`Room invite info copied to clipboard! Share code ${session.code} with your friends.`);
    }
  });

  // ---------------------------------------------------------------
  // Socket Handlers
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
  // UI Rendering
  // ---------------------------------------------------------------
  function renderAll() { renderPeople(); renderQueue(); renderNowPlaying(); }

  function renderPeople() {
    const wrap = $('#people-pills');
    wrap.innerHTML = '';
    const users = state.users || [];
    
    $('#listener-count').textContent = `${users.length} listening`;

    users.forEach(u => {
      const avatar = document.createElement('div');
      avatar.className = 'avatar-circle';
      avatar.title = `${u.username}${u.isHost ? ' (Host)' : ''}`;
      avatar.textContent = u.username.slice(0, 2).toUpperCase();
      wrap.appendChild(avatar);
    });

    $('#host-badge').textContent = session.isHost ? 'ROOM HOST' : 'LISTENER';
  }

  function renderQueue() {
    const list = $('#queue-list');
    const empty = $('#queue-empty');
    const countBadge = $('#queue-count-badge');
    
    list.innerHTML = '';
    countBadge.textContent = `${state.queue.length} songs`;

    if (state.queue.length === 0) {
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');

    state.queue.forEach((track, i) => {
      const li = document.createElement('li');
      li.className = 'queue-item' + (i === state.currentIndex ? ' is-current' : '');
      li.innerHTML = `
        <span class="queue-idx">${i + 1}</span>
        <div class="queue-item-meta">
          <div class="queue-item-title">${escapeHtml(track.name)}</div>
          <div class="queue-item-sub">added by ${escapeHtml(track.addedBy)}</div>
        </div>
      `;
      if (session.isHost) {
        const removeBtn = document.createElement('button');
        removeBtn.className = 'queue-remove-btn';
        removeBtn.innerHTML = '×';
        removeBtn.title = 'Remove song';
        removeBtn.type = 'button';
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
    updateVisualizer();
    startResyncLoop();
  }

  function updatePlayPauseIcon() {
    const playing = state.playback.isPlaying;
    $('#icon-play').classList.toggle('hidden', playing);
    $('#icon-pause').classList.toggle('hidden', !playing);
  }

  function updateVisualizer() {
    const visualizer = $('#visualizer-bars');
    if (state.playback.isPlaying) {
      visualizer.classList.add('is-playing');
    } else {
      visualizer.classList.remove('is-playing');
    }
  }

  // ---------------------------------------------------------------
  // Playback & Syncing
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
  // Host Playback Actions
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
  // Song Upload Handler
  // ---------------------------------------------------------------
  fileInput.addEventListener('change', async (e) => {
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
      statusEl.textContent = `Added "${data.track.name}" to queue.`;
    } catch (err) {
      statusEl.textContent = err.message;
    } finally {
      e.target.value = '';
      setTimeout(() => { statusEl.textContent = ''; }, 4000);
    }
  });

  // ---------------------------------------------------------------
  // Leave Room Action
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
