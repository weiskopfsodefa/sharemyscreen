import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 3000;

// Raum bleibt nach Host-Disconnect kurz bestehen, damit ein Reload den Raum behalten kann.
const ROOM_GRACE_MS = 5 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const MAX_VIEWERS_PER_ROOM = 20;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

/** @type {Map<string, {hostSocket: import('ws').WebSocket|null, hostToken: string, viewers: Map<string, import('ws').WebSocket>, closeTimer: NodeJS.Timeout|null}>} */
const rooms = new Map();

function generateRoomCode() {
  let code = '';
  do {
    code = Array.from(crypto.randomBytes(CODE_LENGTH))
      .map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length])
      .join('');
  } while (rooms.has(code));
  return code;
}

function send({ socket, message }) {
  if (socket && socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function broadcastToViewers({ room, message }) {
  for (const viewerSocket of room.viewers.values()) {
    send({ socket: viewerSocket, message });
  }
}

function scheduleRoomClose({ code }) {
  const room = rooms.get(code);
  if (!room) return;
  room.closeTimer = setTimeout(() => {
    broadcastToViewers({ room, message: { type: 'room:closed' } });
    rooms.delete(code);
  }, ROOM_GRACE_MS);
}

// --- Signaling-Nachrichten ---

function handleHostCreate({ socket }) {
  const code = generateRoomCode();
  const hostToken = crypto.randomBytes(16).toString('hex');
  rooms.set(code, { hostSocket: socket, hostToken, viewers: new Map(), closeTimer: null });
  socket.meta = { role: 'host', code };
  send({ socket, message: { type: 'host:created', code, hostToken } });
}

function handleHostReclaim({ socket, message }) {
  const room = rooms.get(message.code);
  if (!room || room.hostToken !== message.hostToken) {
    send({ socket, message: { type: 'error', code: 'room-not-found' } });
    return;
  }
  if (room.closeTimer) {
    clearTimeout(room.closeTimer);
    room.closeTimer = null;
  }
  room.hostSocket = socket;
  socket.meta = { role: 'host', code: message.code };
  send({ socket, message: { type: 'host:created', code: message.code, hostToken: room.hostToken } });
  broadcastToViewers({ room, message: { type: 'host:online' } });
  for (const viewerId of room.viewers.keys()) {
    send({ socket, message: { type: 'viewer:joined', viewerId } });
  }
}

function handleViewerJoin({ socket, message }) {
  const code = String(message.code || '').toUpperCase();
  const room = rooms.get(code);
  if (!room) {
    send({ socket, message: { type: 'error', code: 'room-not-found' } });
    return;
  }
  const viewerId = message.viewerId || crypto.randomBytes(4).toString('hex');
  const isRejoin = room.viewers.has(viewerId);
  if (!isRejoin && room.viewers.size >= MAX_VIEWERS_PER_ROOM) {
    send({ socket, message: { type: 'error', code: 'room-full' } });
    return;
  }
  room.viewers.set(viewerId, socket);
  socket.meta = { role: 'viewer', code, viewerId };
  send({ socket, message: { type: 'viewer:joined', viewerId, hostOnline: Boolean(room.hostSocket) } });
  send({ socket: room.hostSocket, message: { type: 'viewer:joined', viewerId } });
}

function handleSignal({ socket, message }) {
  const meta = socket.meta;
  if (!meta) return;
  const room = rooms.get(meta.code);
  if (!room) return;
  if (meta.role === 'host') {
    const viewerSocket = room.viewers.get(message.to);
    send({ socket: viewerSocket, message: { type: 'signal', from: 'host', payload: message.payload } });
  } else {
    send({ socket: room.hostSocket, message: { type: 'signal', from: meta.viewerId, payload: message.payload } });
  }
}

function handleDisconnect({ socket }) {
  const meta = socket.meta;
  if (!meta) return;
  const room = rooms.get(meta.code);
  if (!room) return;
  if (meta.role === 'host') {
    if (room.hostSocket === socket) {
      room.hostSocket = null;
      broadcastToViewers({ room, message: { type: 'host:offline' } });
      scheduleRoomClose({ code: meta.code });
    }
  } else if (room.viewers.get(meta.viewerId) === socket) {
    room.viewers.delete(meta.viewerId);
    send({ socket: room.hostSocket, message: { type: 'viewer:left', viewerId: meta.viewerId } });
  }
}

const MESSAGE_HANDLERS = {
  'host:create': handleHostCreate,
  'host:reclaim': handleHostReclaim,
  'viewer:join': handleViewerJoin,
  signal: handleSignal,
};

// --- HTTP: statische Dateien + hübsche Routen ---

const ROUTE_FILES = {
  '/': 'index.html',
  '/host': 'host.html',
};

function resolveStaticFile({ urlPath }) {
  if (ROUTE_FILES[urlPath]) return path.join(PUBLIC_DIR, ROUTE_FILES[urlPath]);
  if (/^\/v\/[A-Za-z0-9]+$/.test(urlPath)) return path.join(PUBLIC_DIR, 'viewer.html');
  const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) return null;
  return filePath;
}

function serveQrCode({ url, res }) {
  const text = url.searchParams.get('text') || '';
  if (!text || text.length > 300) {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }
  QRCode.toString(text, { type: 'svg', margin: 1, color: { dark: '#1d130a', light: '#fff8ee' } }, (err, svg) => {
    if (err) {
      res.writeHead(500);
      res.end('QR-Fehler');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache' });
    res.end(svg);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const urlPath = decodeURIComponent(url.pathname);
  if (urlPath === '/qr.svg') {
    serveQrCode({ url, res });
    return;
  }
  const filePath = resolveStaticFile({ urlPath });
  if (!filePath) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err || !path.extname(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Nicht gefunden');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

// --- WebSocket-Signaling ---

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (socket) => {
  socket.isAlive = true;
  socket.on('pong', () => {
    socket.isAlive = true;
  });
  socket.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const handler = MESSAGE_HANDLERS[message.type];
    if (handler) handler({ socket, message });
  });
  socket.on('close', () => handleDisconnect({ socket }));
});

setInterval(() => {
  for (const socket of wss.clients) {
    if (!socket.isAlive) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, HEARTBEAT_INTERVAL_MS).unref();

server.listen(PORT, () => {
  console.log(`sharemyscreen läuft auf http://localhost:${PORT}`);
});
