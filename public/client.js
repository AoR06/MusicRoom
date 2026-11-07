(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  const audioEl = $('#audio-el');
  const enableAudioBtn = $('#enable-audio-btn');
  const socket = io();

  // ---------------------------------------------------------------
  // Clock sync: estimate our offset from the server's clock so every
  // listener can compute the same "what position should play now".
  // ---------------------------------------------------------------
  let clockOffset = 0; // serverTime ≈ Date.now() + clockOffset

  function syncClock(rounds = 5) {
    return new Promise((resolve) => {
      let best = null;
      let done = 0;
      const ping = () => socket.emit('time-sync', Date.now());
      const onReply = ({ clientTime, serverTime }) => {
        const t3 = Date.now();
        const rtt = t3 - clientTime;
        const offset = serverTime - (clientTime + t3) / 2;
        if (!best || rtt < best.rtt) best = { rtt, offset };
        done += 1;
        if (done >= rounds) {
          socket.off('time-sync-reply', onReply);
          clockOffset = best.offset;
          resolve();
        } else {
          setTimeout(ping, 80);
        }
      };
      socket.on('time-sync-reply', onReply);
      ping();
    });
  }

  const serverNow = () => Date.now() + clockOffset;

  // ---------------------------------------------------------------
  // State
  // ---------------------------------------------------------------
  let session = { code: null, username: null, hostToken: null, isHost: false };
  let state = null;
  let loadedTrackId = null;
  let resyncTimer = null;
  let busy = false;

  // ---------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (_) { return false; }
  }

  function formatTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  function initials(name) {
    return (name || '?').trim().slice(0, 2).toUpperCase();
  }

  function avatarGradient(name) {
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return `linear-gradient(135deg, hsl(${h},75%,62%), hsl(${(h + 50) % 360},70%, 48%))`;
  }

  // ---------------------------------------------------------------
  // Navigation between screens
  // ---------------------------------------------------------------
  const VIEWS = ['home', 'room'];

  function show(name) {
    VIEWS.forEach((v) => $(`#${v}-view`).classList.toggle('hidden', v !== name));
    $$('.error').forEach((e) => { e.textContent = ''; });
    window.scrollTo(0, 0);
  }

  // ---------------------------------------------------------------
  // Light / dark theme (the saved choice is applied before first paint
  // by a tiny script in index.html; this handles the toggle buttons)
  // ---------------------------------------------------------------
  const root = document.documentElement;
  function applyTheme(theme) {
    root.setAttribute('data-theme', theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'light' ? '#F4ECFB' : '#0F0A1E');
  }
  applyTheme(root.getAttribute('data-theme') || 'dark');

  $$('.js-theme-btn').forEach((btn) => btn.addEventListener('click', () => {
    const next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    applyTheme(next);
    try { localStorage.setItem('musiq-theme', next); } catch (_) { /* private mode, ignore */ }
  }));

  function setTab(name) {
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    $('#tab-playing').classList.toggle('hidden', name !== 'playing');
    $('#tab-queue').classList.toggle('hidden', name !== 'queue');
  }
  $$('.tab').forEach((t) => t.addEventListener('click', () => setTab(t.dataset.tab)));

  function openAdd() { $('#add-view').classList.remove('hidden'); }
  function closeAdd() { $('#add-view').classList.add('hidden'); }
  $$('.js-open-add').forEach((b) => b.addEventListener('click', openAdd));
  $('#add-close-btn').addEventListener('click', closeAdd);

  // Join link support: /?room=ABCDE jumps straight to the join screen
  const preRoom = new URLSearchParams(location.search).get('room');
  if (preRoom) {
    $('#join-code').value = preRoom.toUpperCase().slice(0, 5);
    setTimeout(() => {
      $('#join-card').scrollIntoView({ behavior: 'smooth', block: 'center' });
      $('#join-username').focus({ preventScroll: true });
    }, 300);
  }
  $('#join-code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase(); });

  // ---------------------------------------------------------------
  // Create / join
  // ---------------------------------------------------------------
  async function enterRoom({ code, username, hostToken }, errorEl) {
    await syncClock();
    return new Promise((resolve) => {
      socket.emit('join-room', { code, username, hostToken }, (resp) => {
        if (!resp || resp.error) {
          errorEl.textContent = resp?.error || 'Could not join the room.';
          return resolve(false);
        }
        session = { code, username, hostToken, isHost: resp.isHost };
        state = resp.state;
        $('#room-code-display').textContent = code;
        show('room');
        setTab('playing');
        renderAll();
        resolve(true);
      });
    });
  }

  $('#create-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    const errorEl = $('#host-error');
    errorEl.textContent = '';
    const username = $('#create-username').value.trim();
    if (!username) return;
    busy = true;
    try {
      const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not create the room.');
      await enterRoom({ code: data.code, username, hostToken: data.hostToken }, errorEl);
    } catch (err) {
      errorEl.textContent = err.message;
    } finally {
      busy = false;
    }
  });

  $('#join-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    const errorEl = $('#join-error');
    errorEl.textContent = '';
    const username = $('#join-username').value.trim();
    const code = $('#join-code').value.trim().toUpperCase();
    if (!username || !code) return;
    busy = true;
    try {
      await enterRoom({ code, username, hostToken: null }, errorEl);
    } finally {
      busy = false;
    }
  });

  // ---------------------------------------------------------------
  // Socket events (server -> client)
  // ---------------------------------------------------------------
  socket.on('room-updated', (s) => { state = s; renderPeople(); renderQueue(); });
  socket.on('queue-updated', (s) => { state = s; renderQueue(); renderNowPlaying(); });
  socket.on('playback-update', (s) => { state = s; renderQueue(); renderNowPlaying(); });
  socket.on('room-closed', ({ reason }) => {
    alert(reason === 'host-left'
      ? 'The host left and the room has closed.'
      : 'This room closed due to inactivity.');
    window.location.href = '/';
  });

  // If the connection drops (common on phones) and comes back, rejoin quietly.
  socket.on('connect', async () => {
    if (!session.code) return;
    await syncClock();
    socket.emit('join-room', {
      code: session.code, username: session.username, hostToken: session.hostToken,
    }, (resp) => {
      if (!resp || resp.error) {
        alert('This room is no longer available.');
        window.location.href = '/';
        return;
      }
      session.isHost = resp.isHost;
      state = resp.state;
      renderAll();
    });
  });

  // ---------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------
  function renderAll() { renderPeople(); renderQueue(); renderNowPlaying(); }

  function renderPeople() {
    $('#listening-count').textContent = `${state.users.length} listening now`;
    $('#host-badge').textContent = session.isHost ? 'You are hosting' : '';

    const wrap = $('#avatars');
    wrap.innerHTML = '';
    const MAX = 4;
    state.users.slice(0, MAX).forEach((u) => {
      const a = document.createElement('span');
      a.className = 'avatar' + (u.isHost ? ' is-host' : '');
      a.style.background = avatarGradient(u.username);
      a.title = u.username + (u.isHost ? ' (host)' : '');
      a.textContent = initials(u.username);
      wrap.appendChild(a);
    });
    if (state.users.length > MAX) {
      const more = document.createElement('span');
      more.className = 'avatar more';
      more.textContent = `+${state.users.length - MAX}`;
      wrap.appendChild(more);
    }
  }

  function renderQueue() {
    $('#queue-count').textContent = state.queue.length;
    const list = $('#queue-list');
    const empty = $('#queue-empty');
    list.innerHTML = '';
    empty.classList.toggle('hidden', state.queue.length > 0);

    state.queue.forEach((track, i) => {
      const isCurrent = i === state.currentIndex;
      const who = track.addedBy === session.username ? 'You' : track.addedBy;
      const li = document.createElement('li');
      li.className = 'queue-item'
        + (isCurrent ? ' is-current' : '')
        + (isCurrent && !state.playback.isPlaying ? ' paused' : '');
      li.innerHTML = `
        <span class="q-badge">${isCurrent ? '<span class="eq"><i></i><i></i><i></i></span>' : i + 1}</span>
        <span class="q-meta">
          <span class="q-name">${escapeHtml(track.name)}</span>
          <span class="q-sub">${isCurrent ? 'Playing now · ' : ''}Added by ${escapeHtml(who)}</span>
        </span>`;
      if (session.isHost) {
        const rm = document.createElement('button');
        rm.className = 'q-remove';
        rm.setAttribute('aria-label', 'Remove song');
        rm.innerHTML = '<svg class="ic" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
        rm.addEventListener('click', () => socket.emit('remove-song', track.id));
        li.appendChild(rm);
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
    $('#track-added-by').textContent = `Added by ${track.addedBy === session.username ? 'You' : track.addedBy}`;
    $('#host-controls').classList.toggle('hidden', !session.isHost);
    $('#listener-note').classList.toggle('hidden', session.isHost);

    if (loadedTrackId !== track.id) {
      loadedTrackId = track.id;
      audioEl.src = `/api/rooms/${session.code}/tracks/${track.id}`;
      // Seeking before metadata loads is unreliable, so re-apply once it's ready.
      audioEl.addEventListener('loadedmetadata', applyPlaybackState, { once: true });
      updateMediaSession(track);
    }

    applyPlaybackState();
    const playing = state.playback.isPlaying;
    $('#icon-play').classList.toggle('hidden', playing);
    $('#icon-pause').classList.toggle('hidden', !playing);
    startResyncLoop();
  }

  // Lock-screen / notification controls so audio keeps behaving like a media app
  function updateMediaSession(track) {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.name,
        artist: `Added by ${track.addedBy}`,
        album: 'Musiq',
      });
      const set = (action, fn) => { try { navigator.mediaSession.setActionHandler(action, fn); } catch (_) {} };
      if (session.isHost) {
        set('play', () => socket.emit('playback-play'));
        set('pause', () => socket.emit('playback-pause'));
        set('nexttrack', () => socket.emit('playback-skip'));
      }
    } catch (_) { /* not supported, ignore */ }
  }

  // ---------------------------------------------------------------
  // Playback sync: nudge the local <audio> toward the server's position
  // ---------------------------------------------------------------
  function expectedPositionMs() {
    const pb = state.playback;
    if (!pb.startedAt) return 0;
    return pb.isPlaying ? serverNow() - pb.startedAt : pb.pausedAtPositionMs;
  }

  function applyPlaybackState() {
    if (!state || !audioEl.src) return;
    const targetSec = Math.max(0, expectedPositionMs() / 1000);
    const drift = Math.abs(audioEl.currentTime - targetSec);
    if (drift > 0.35 || Number.isNaN(audioEl.currentTime)) {
      try { audioEl.currentTime = targetSec; } catch (_) {}
    }
    if (state.playback.isPlaying) {
      audioEl.play().then(() => {
        enableAudioBtn.classList.add('hidden');
      }).catch(() => {
        // Phones block audio the person didn't start with a tap — offer a one-tap unlock.
        enableAudioBtn.classList.remove('hidden');
      });
    } else {
      audioEl.pause();
      enableAudioBtn.classList.add('hidden');
    }
  }

  enableAudioBtn.addEventListener('click', () => {
    audioEl.play().then(() => enableAudioBtn.classList.add('hidden')).catch(() => {});
  });

  function startResyncLoop() {
    if (resyncTimer) clearInterval(resyncTimer);
    resyncTimer = setInterval(() => {
      if (state && state.currentIndex >= 0) applyPlaybackState();
    }, 2500);
  }

  audioEl.addEventListener('timeupdate', () => {
    $('#time-current').textContent = formatTime(audioEl.currentTime);
    if (Number.isFinite(audioEl.duration)) $('#time-total').textContent = formatTime(audioEl.duration);
    const pct = audioEl.duration ? (audioEl.currentTime / audioEl.duration) * 100 : 0;
    $('#progress-fill').style.width = `${pct}%`;
    $('#progress-knob').style.left = `${pct}%`;
  });

  audioEl.addEventListener('ended', () => {
    // Name the track that ended so the server only advances once, not once per listener.
    socket.emit('track-ended', loadedTrackId);
  });

  // ---------------------------------------------------------------
  // Host controls
  // ---------------------------------------------------------------
  $('#play-pause-btn').addEventListener('click', () => {
    if (!session.isHost) return;
    // This tap also unlocks audio on phones for the host.
    audioEl.play().catch(() => {});
    socket.emit(state.playback.isPlaying ? 'playback-pause' : 'playback-play');
  });

  $('#skip-btn').addEventListener('click', () => {
    if (session.isHost) socket.emit('playback-skip');
  });

  $('#progress-track').addEventListener('click', (e) => {
    if (!session.isHost || !audioEl.duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    socket.emit('playback-seek', pct * audioEl.duration * 1000);
  });

  // ---------------------------------------------------------------
  // Add song (upload)
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
      statusEl.textContent = `Added "${data.track.name}" ✓`;
      setTimeout(() => { closeAdd(); setTab('queue'); statusEl.textContent = ''; }, 800);
    } catch (err) {
      statusEl.textContent = err.message;
    } finally {
      e.target.value = '';
    }
  });

  // ---------------------------------------------------------------
  // Room header actions
  // ---------------------------------------------------------------
  $('#copy-code-btn').addEventListener('click', async () => {
    const ok = await copyText(session.code);
    toast(ok ? 'Room code copied' : `Room code: ${session.code}`);
  });

  $('#invite-btn').addEventListener('click', async () => {
    const url = `${location.origin}/?room=${session.code}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Join my Musiq room', text: `Join my Musiq room — code ${session.code}`, url });
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    }
    const ok = await copyText(url);
    toast(ok ? 'Invite link copied' : url);
  });

  $('#leave-btn').addEventListener('click', () => {
    socket.emit('leave-room');
    window.location.href = '/';
  });
})();
