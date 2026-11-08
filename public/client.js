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
    form.append('username', session.username || 'Someone');
    form.append('displayName', file.name.replace(/\.mp3$/i, ''));

    try {
      const res = await fetch(`/api/rooms/${session.code}/upload`, { 
        method: 'POST', 
        body: form 
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed.');
      statusEl.textContent = `Added "${data.track.name}" to queue.`;
    } catch (err) {
      statusEl.textContent = err.message;
    } finally {
      fileInput.value = '';
      setTimeout(() => { statusEl.textContent = ''; }, 4000);
    }
  });
