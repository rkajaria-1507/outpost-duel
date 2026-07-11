/* Outpost Duel — static file server + WebSocket relay for online play.
   The relay is a dumb pass-through: it never touches game state, it just
   pairs a host + guest into a room by code and forwards messages between
   them. All game logic runs authoritatively on the host's browser tab. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8642;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let reqPath = decodeURIComponent(req.url.split('?')[0]);
  if (reqPath === '/') reqPath = '/index.html';
  const filePath = path.join(ROOT, reqPath);
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: '/ws' });

/** rooms: Map<code, {host: ws|null, guest: ws|null}> */
const rooms = new Map();

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

wss.on('connection', (ws) => {
  ws.roomCode = null;
  ws.role = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'host') {
      const code = makeCode();
      rooms.set(code, { host: ws, guest: null });
      ws.roomCode = code; ws.role = 'host';
      send(ws, { type: 'hosted', code });
      return;
    }

    if (msg.type === 'join') {
      const room = rooms.get((msg.code || '').toUpperCase());
      if (!room || !room.host) { send(ws, { type: 'error', message: 'Room not found.' }); return; }
      if (room.guest) { send(ws, { type: 'error', message: 'Room already full.' }); return; }
      room.guest = ws;
      ws.roomCode = room.host.roomCode; ws.role = 'guest';
      send(ws, { type: 'joined' });
      send(room.host, { type: 'guestJoined' });
      return;
    }

    // Anything else: relay verbatim to the other peer in the room.
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    const peer = ws.role === 'host' ? room.guest : room.host;
    send(peer, msg);
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    const peer = ws.role === 'host' ? room.guest : room.host;
    send(peer, { type: 'peerLeft' });
    if (ws.role === 'host') rooms.delete(ws.roomCode);
    else room.guest = null;
  });
});

server.listen(PORT, () => {
  console.log(`Outpost Duel serving on http://localhost:${PORT} (WebSocket relay at /ws)`);
});
