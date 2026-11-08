(() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const homeView = $('#home-view');
  const roomView = $('#room-view');
  const homeError = $('#home-error');
  const fileInput = $('#file-input');
  const audioEl = $('#audio-el');

  const socket = io();

  // Theme Logic
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

  document.addEventListener('click', (e) => {
    if (e.target.closest('.theme-toggle-btn')) {
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      applyTheme(isDark ? 'light' : 'dark');
    }
    if (e.target.closest('.trigger-upload-btn')) {
      fileInput.click();
    }
  });

  // State & Room
  let session = { code: null, username: null, isHost: false };
  let state = null;
  let loadedTrackId = null;

  function showError(msg) { homeError.textContent = msg || ''; }

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
      enterRoom(data.code, username, data.hostToken);
    } catch (err) {
      showError(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '+ Create Room';
    }
  });

  $('#join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    showError('');
    const username = $('#join-username').value.trim();
    const code = $('#join-code').value.trim().toUpperCase();
    if (username && code) enterRoom(code, username, null);
  });

  function enterRoom(code, username, hostToken) {
    socket.emit('join-room', { code, username, hostToken }, (resp) => {
      if (resp?.error) {
        showError(resp.error);
        return;
      }
      session = { code, username, isHost: resp.isHost };
      state = resp.state;

      homeView.classList.add('hidden');
      roomView.classList.remove('hidden');
      $('#room-code-display').textContent = code;
      renderAll();
    });
  }

  // Upload Logic
  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file || !session.code) return;

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
      statusEl.textContent = `Added "${data.track.name}"`;
    } catch (err) {
      statusEl.textContent = err.message;
    } finally {
      fileInput.value = '';
      setTimeout(() => { statusEl.textContent = ''; }, 3500);
    }
  });

  // Socket Handlers
  socket.on('room-updated', (s) => { state = s; renderPeople(); renderQueue(); });
  socket.on('queue-updated', (s) => { state = s; renderQueue(); renderNowPlaying(); });
  socket.on('playback-update', (s) => { state = s; renderNowPlaying(); });

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
    list.innerHTML = '';
    $('#queue-count-badge').textContent = `${state.queue.length} songs`;

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
      list.appendChild(li);
    });
  }

  function renderNowPlaying() {
    const track = state.queue[state.currentIndex];
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

    if (loadedTrackId !== track.id) {
      loadedTrackId = track.id;
      audioEl.src = `/api/rooms/${session.code}/tracks/${track.id}`;
    }

    if (state.playback.isPlaying) {
      audioEl.play().catch(() => {});
    } else {
      audioEl.pause();
    }

    const playing = state.playback.isPlaying;
    $('#icon-play').classList.toggle('hidden', playing);
    $('#icon-pause').classList.toggle('hidden', !playing);
    $('#visualizer-bars').classList.toggle('is-playing', playing);
  }

  audioEl.addEventListener('timeupdate', () => {
    if (!state || Number.isNaN(audioEl.duration)) return;
    $('#time-current').textContent = formatTime(audioEl.currentTime);
    $('#time-total').textContent = formatTime(audioEl.duration);
    const pct = (audioEl.currentTime / audioEl.duration) * 100;
    $('#progress-fill').style.width = `${pct}%`;
  });

  function formatTime(sec) {
    if (Number.isNaN(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  $('#play-pause-btn').addEventListener('click', () => {
    if (!session.isHost) return;
    if (state.playback.isPlaying) socket.emit('playback-pause');
    else socket.emit('playback-play');
  });

  $('#skip-btn').addEventListener('click', () => {
    if (session.isHost) socket.emit('playback-skip');
  });

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

  $('#leave-btn').addEventListener('click', () => window.location.reload());

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
})();
