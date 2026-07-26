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
const MAX_WS_PAYLOAD_BYTES = 64 * 1024;

// Ohne festes Secret sind Tokens nur bis zum nächsten Neustart gültig –
// Raum-Codes (und gedruckte QR-Codes) überleben den Neustart dann nicht.
const HOST_TOKEN_SECRET = process.env.HOST_TOKEN_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.HOST_TOKEN_SECRET) {
  console.warn('HOST_TOKEN_SECRET ist nicht gesetzt – Raum-Codes überleben keinen Server-Neustart.');
}

// Host-Tokens sind per HMAC an den Raum-Code gebunden. Nur der Server kann gültige
// Tokens ausstellen – niemand kann einen fremden (z. B. gedruckten) Code nach einem
// Server-Neustart mit einem selbst gewählten Token kapern.
function hostTokenFor({ code }) {
  return crypto.createHmac('sha256', HOST_TOKEN_SECRET).update(code).digest('hex').slice(0, 32);
}

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

/** @type {Map<string, {hostSocket: import('ws').WebSocket|null, viewers: Map<string, import('ws').WebSocket>, closeTimer: NodeJS.Timeout|null}>} */
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
  // Hängt der Socket noch in einem alten Raum, diesen sauber verlassen –
  // sonst bleibt der alte Raum für immer verwaist in der Map.
  handleDisconnect({ socket });
  const code = generateRoomCode();
  rooms.set(code, { hostSocket: socket, viewers: new Map(), closeTimer: null });
  socket.meta = { role: 'host', code };
  send({ socket, message: { type: 'host:created', code, hostToken: hostTokenFor({ code }) } });
}

function handleHostReclaim({ socket, message }) {
  const code = String(message.code || '').toUpperCase();
  const hostToken = String(message.hostToken || '');
  const expected = /^[A-Z0-9]{4,8}$/.test(code) ? hostTokenFor({ code }) : null;
  const tokenOk = expected !== null && hostToken.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(hostToken), Buffer.from(expected));
  if (!tokenOk) {
    send({ socket, message: { type: 'error', code: 'room-not-found' } });
    return;
  }
  if (socket.meta && (socket.meta.role !== 'host' || socket.meta.code !== code)) {
    handleDisconnect({ socket });
  }
  // Existiert der Raum nicht mehr (Server-Neustart), wird er mit demselben Code
  // neu angelegt – Raum-Codes und gedruckte QR-Codes bleiben so dauerhaft gültig.
  const room = rooms.get(code) ?? { hostSocket: socket, viewers: new Map(), closeTimer: null };
  rooms.set(code, room);
  if (room.closeTimer) {
    clearTimeout(room.closeTimer);
    room.closeTimer = null;
  }
  room.hostSocket = socket;
  socket.meta = { role: 'host', code };
  send({ socket, message: { type: 'host:created', code, hostToken } });
  broadcastToViewers({ room, message: { type: 'host:online' } });
  for (const [viewerId, viewerSocket] of room.viewers) {
    // Bekannte Viewer haben evtl. noch laufende P2P-Verbindungen – kein neues
    // Angebot erzwingen, sonst wird deren Bild grundlos kurz schwarz.
    send({ socket, message: { type: 'viewer:joined', viewerId, name: viewerSocket.meta?.name ?? null, needsOffer: false } });
  }
}

function sanitizeName({ name }) {
  if (typeof name !== 'string') return null;
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
  return clean || null;
}

function handleViewerJoin({ socket, message }) {
  const code = String(message.code || '').toUpperCase();
  const room = rooms.get(code);
  if (!room) {
    send({ socket, message: { type: 'error', code: 'room-not-found' } });
    return;
  }
  if (socket.meta && (socket.meta.role !== 'viewer' || socket.meta.code !== code)) {
    handleDisconnect({ socket });
  }
  const viewerId = typeof message.viewerId === 'string' && /^[a-f0-9]{8}$/.test(message.viewerId)
    ? message.viewerId
    : crypto.randomBytes(4).toString('hex');
  const isRejoin = room.viewers.has(viewerId);
  if (!isRejoin && room.viewers.size >= MAX_VIEWERS_PER_ROOM) {
    send({ socket, message: { type: 'error', code: 'room-full' } });
    return;
  }
  const name = sanitizeName({ name: message.name });
  room.viewers.set(viewerId, socket);
  socket.meta = { role: 'viewer', code, viewerId, name };
  send({ socket, message: { type: 'viewer:joined', viewerId, hostOnline: Boolean(room.hostSocket) } });
  send({ socket: room.hostSocket, message: { type: 'viewer:joined', viewerId, name, needsOffer: message.needsOffer !== false } });
}

function handleViewerRename({ socket, message }) {
  const meta = socket.meta;
  if (meta?.role !== 'viewer') return;
  const room = rooms.get(meta.code);
  if (!room) return;
  meta.name = sanitizeName({ name: message.name });
  send({ socket: room.hostSocket, message: { type: 'viewer:renamed', viewerId: meta.viewerId, name: meta.name } });
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
  'viewer:rename': handleViewerRename,
  signal: handleSignal,
};

// --- HTTP: statische Dateien + hübsche Routen ---

const ROUTE_FILES = {
  '/': 'index.html',
  '/host': 'room.html',
};

function resolveStaticFile({ urlPath }) {
  if (ROUTE_FILES[urlPath]) return path.join(PUBLIC_DIR, ROUTE_FILES[urlPath]);
  // /CODE ist Host UND Viewer (die Seite entscheidet per Token); /v/CODE bleibt
  // für alte QR-Codes erhalten.
  if (/^\/(?:v\/)?[A-Za-z0-9]{4,8}$/.test(urlPath)) return path.join(PUBLIC_DIR, 'room.html');
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
  let url;
  let urlPath;
  try {
    url = new URL(req.url, 'http://localhost');
    urlPath = decodeURIComponent(url.pathname);
  } catch {
    // Kaputte URLs (z. B. ungültiges Percent-Encoding von Scanner-Bots) werfen hier –
    // ohne catch würde eine einzige solche Anfrage den ganzen Prozess beenden.
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }
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

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_WS_PAYLOAD_BYTES });

wss.on('error', (err) => console.error('WebSocket-Server-Fehler', err));

wss.on('connection', (socket) => {
  socket.isAlive = true;
  // Ohne Listener würde ein 'error'-Event (z. B. ein kaputter Frame) den Prozess beenden.
  socket.on('error', () => {});
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
