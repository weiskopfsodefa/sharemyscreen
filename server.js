import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import https from 'node:https';
import { mediaConfig, mediaToken } from './media-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 3000;
const MEDIA = mediaConfig();
if (Boolean(process.env.TLS_CERT) !== Boolean(process.env.TLS_KEY)) throw new Error('TLS_CERT und TLS_KEY müssen zusammen gesetzt sein.');
const TLS = process.env.TLS_CERT && process.env.TLS_KEY
  ? { cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) } : null;
const publicOrigin = MEDIA ? `${TLS ? 'https' : 'http'}://${MEDIA.ip}:${PORT}` : null;
const mediaInfo = () => ({ available: Boolean(MEDIA), publicOrigin });
const transportInfo = (room) => room.transport || { mode: 'direct' };

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
  '.mjs': 'text/javascript; charset=utf-8',
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
  send({ socket, message: { type: 'host:created', code, hostToken: hostTokenFor({ code }), media: mediaInfo() } });
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
  if (message.transport?.mode === 'direct') room.transport = { mode: 'direct' };
  else if (MEDIA && message.transport?.mode === 'livekit' && /^[a-f0-9-]{36}$/.test(message.transport.session || '')) {
    room.transport = { mode: 'livekit', session: message.transport.session };
  }
  room.hostSocket = socket;
  socket.meta = { role: 'host', code };
  send({ socket, message: { type: 'host:created', code, hostToken, media: mediaInfo() } });
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
  send({ socket, message: { type: 'viewer:joined', viewerId, hostOnline: Boolean(room.hostSocket), transport: transportInfo(room) } });
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
  if (room.transport?.mode === 'livekit') return;
  if (meta.role === 'host') {
    if (room.hostSocket !== socket) return;
    const viewerSocket = room.viewers.get(message.to);
    send({ socket: viewerSocket, message: { type: 'signal', from: 'host', payload: message.payload } });
  } else {
    if (room.viewers.get(meta.viewerId) !== socket) return;
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

async function handleTransport({ socket, message }) {
  const meta = socket.meta;
  const room = rooms.get(meta?.code);
  const reply = (data) => send({ socket, message: { type: 'reply', replyTo: message.requestId, ...data } });
  if (!room || meta.role !== 'host' || room.hostSocket !== socket) return reply({ error: 'Nur der Host kann den Übertragungsweg ändern.' });
  if (!['direct', 'livekit'].includes(message.mode)) return reply({ error: 'Ungültiger Übertragungsweg.' });
  if (message.mode === 'livekit' && !MEDIA) return reply({ error: 'Bitte den lokalen Starter öffnen.' });
  // Host darf nach Signaling-Neustart seine bestehende Mediensitzung wiederherstellen.
  const session = /^[a-f0-9-]{36}$/.test(message.session || '') ? message.session : crypto.randomUUID();
  room.transport = message.mode === 'livekit' ? { mode: 'livekit', session } : { mode: 'direct' };
  broadcastToViewers({ room, message: { type: 'room:transport', transport: room.transport } });
  reply({ transport: room.transport });
}

async function handleMediaToken({ socket, message }) {
  const meta = socket.meta;
  const room = rooms.get(meta?.code);
  const current = () => room && rooms.get(meta.code) === room && (meta.role === 'host'
    ? room.hostSocket === socket : room.viewers.get(meta.viewerId) === socket);
  const reply = (data) => send({ socket, message: { type: 'reply', replyTo: message.requestId, ...data } });
  if (!MEDIA || !current() || room.transport?.mode !== 'livekit' || message.session !== room.transport.session) {
    return reply({ error: 'Mediensitzung nicht aktiv. Verbinde erneut.' });
  }
  const token = await mediaToken(MEDIA, { ...meta, session: message.session });
  if (!current() || room.transport?.session !== message.session) return;
  reply({ token, url: TLS ? `wss://${MEDIA.ip}:${PORT}/livekit` : `ws://${MEDIA.ip}:7880` });
}

const MESSAGE_HANDLERS = {
  'host:transport': handleTransport,
  'media:token': handleMediaToken,
  ping: ({ socket }) => send({ socket, message: { type: 'pong' } }),
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

const handleHttp = (req, res) => {
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
  if (MEDIA && TLS && req.method === 'GET' && /^\/livekit\/rtc(?:\/v\d+)?\/validate$/.test(urlPath)) {
    fetch(`http://127.0.0.1:7880${urlPath.slice('/livekit'.length)}${url.search}`, { signal: AbortSignal.timeout(5000) })
      .then(async upstream => {
        const body = await upstream.text();
        res.writeHead(upstream.status, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        res.end(body);
      }).catch(() => { res.writeHead(502); res.end('LiveKit nicht erreichbar'); });
    return;
  }
  if (urlPath === '/qr.svg') {
    serveQrCode({ url, res });
    return;
  }
  const filePath = urlPath === '/vendor/livekit.mjs'
    ? path.join(__dirname, 'node_modules/livekit-client/dist/livekit-client.esm.mjs')
    : resolveStaticFile({ urlPath });
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
    if (MEDIA && ext === '.html') {
      // Offline mode does not contact Google Fonts; use the existing fallback fonts.
      data = Buffer.from(data.toString().replace(/<link[^>]+https:\/\/fonts\.(?:googleapis|gstatic)\.com[^>]*>/g, ''));
    }
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
};
const server = TLS ? https.createServer(TLS, handleHttp) : http.createServer(handleHttp);

// --- WebSocket-Signaling ---

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD_BYTES });
const mediaProxy = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/ws') return wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  if (MEDIA && TLS && url.pathname.startsWith('/livekit/')) {
    return mediaProxy.handleUpgrade(req, socket, head, (client) => {
      const upstream = new WebSocket(`ws://127.0.0.1:7880${url.pathname.slice('/livekit'.length)}${url.search}`);
      const pending = [];
      client.on('message', (data, binary) => {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
        else if (pending.length < 32) pending.push([data, binary]);
        else client.close();
      });
      upstream.on('open', () => pending.splice(0).forEach(([data, binary]) => upstream.send(data, { binary })));
      upstream.on('message', (data, binary) => { if (client.readyState === WebSocket.OPEN) client.send(data, { binary }); });
      client.on('close', () => upstream.close());
      upstream.on('close', () => client.close());
      client.on('error', () => upstream.close());
      upstream.on('error', () => client.close());
    });
  }
  socket.destroy();
});

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
    if (!message || typeof message.type !== 'string') return;
    const handler = MESSAGE_HANDLERS[message.type];
    if (typeof handler === 'function') {
      Promise.resolve().then(() => handler({ socket, message })).catch(() => {
        send({ socket, message: { type: 'reply', replyTo: message.requestId, error: 'Server-Anfrage fehlgeschlagen.' } });
      });
    }
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

server.listen(PORT, process.env.BIND_ADDRESS || '0.0.0.0', () => {
  console.log(`sharemyscreen läuft auf ${TLS ? 'https' : 'http'}://localhost:${PORT}`);
});
