# Listening Room

Host a room, share the 5-letter code, and everyone hears the same MP3 at the
same moment — no accounts, no app installs, just a username and a code.

## What it does

- **Host creates a room** → gets a shareable room code.
- **Anyone joins** with just a username + the code. No login, no signup.
- **Anyone can add a song** (MP3 upload) to the shared queue.
- **Only the host can control playback** — play/pause, skip, seek, remove
  songs, reorder the queue.
- Songs play in the order they were added, automatically.
- Playback is kept in close sync across every listener's browser (see
  "How sync works" below).
- The room and its uploaded files are deleted automatically when the host
  leaves (after a short grace period, in case of a dropped connection) or
  after 2 hours of inactivity.

## Running it

Requires Node.js 18+.

```bash
npm install
npm start
```

Then open `http://localhost:3000` in a browser. To let friends on other
devices join, they need to reach that address — either you're all on the
same network and they use your machine's local IP (e.g.
`http://192.168.1.23:3000`), or you deploy the app to a small always-on host
(Render, Fly.io, a VPS, etc.) and share that public URL instead.

## How sync works

There's no way to get literally zero latency over a network — audio still
has to travel from the server to every device. What this app does instead is
keep everyone's *position in the track* aligned, so the drift is small
enough (well under half a second) that it feels simultaneous:

1. Each browser measures the difference between its own clock and the
   server's clock using a handful of ping/pong round trips (like a mini NTP
   sync), done once when joining.
2. The server is the single source of truth for playback: it stores *when*
   (in server time) the current track started, and whether it's playing or
   paused — not "where" each client currently is.
3. Every client continuously computes "what position should I be at right
   now" from that server timestamp plus its measured clock offset, and
   nudges its `<audio>` element to match if it's drifted by more than
   ~350ms.
4. Whenever the host plays, pauses, seeks, or skips, the server broadcasts
   the new authoritative state instantly over WebSockets, and every client
   re-syncs immediately.

The practical result: everyone hears each song start together and stays
aligned throughout, even if someone joins mid-track or their connection
briefly hiccups.

## Limits worth knowing

- MP3 files only, 40MB max per track (adjustable in `server.js`).
- Room state lives in memory — restarting the server clears all rooms. Fine
  for casual use; would need a database for anything long-lived or
  multi-server.
- No content moderation on uploaded files beyond checking the extension —
  don't expose this publicly without adding some.
- Built for small rooms (a handful to a few dozen people); it isn't load
  tested beyond that.

## Project structure

```
server.js          Express + Socket.io backend: rooms, uploads, playback state
public/
  index.html        Home (create/join) and room views
  style.css         Styling
  client.js         Socket handling, clock sync, playback correction
uploads/<code>/     MP3s for each active room (deleted when the room closes)
```
