// Smoke-Test für den Signaling-Server: Raum anlegen, Viewer beitreten,
// SDP/ICE in beide Richtungen weiterleiten, Host-Disconnect.
// Aufruf: npm run smoke-test (startet eigenen Server auf Port 3199)

import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const PORT = 3199;
const URL = `ws://localhost:${PORT}/ws`;

function fail({ reason }) {
  console.error(`✗ ${reason}`);
  process.exit(1);
}

function openSocket() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(URL);
    socket.inbox = [];
    socket.waiters = [];
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      const waiterIndex = socket.waiters.findIndex(({ type }) => type === message.type);
      if (waiterIndex >= 0) {
        socket.waiters.splice(waiterIndex, 1)[0].resolve(message);
      } else {
        socket.inbox.push(message);
      }
    });
    socket.on('open', () => resolve(socket));
    socket.on('error', reject);
  });
}

function waitFor({ socket, type, timeoutMs = 3000 }) {
  const buffered = socket.inbox.findIndex((message) => message.type === type);
  if (buffered >= 0) return Promise.resolve(socket.inbox.splice(buffered, 1)[0]);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout: warte auf "${type}"`)), timeoutMs);
    socket.waiters.push({
      type,
      resolve: (message) => {
        clearTimeout(timer);
        resolve(message);
      },
    });
  });
}

function sendJson({ socket, message }) {
  socket.send(JSON.stringify(message));
}

const server = spawn('node', ['server.js'], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'inherit'],
});

await new Promise((resolve, reject) => {
  server.stdout.on('data', (chunk) => {
    if (chunk.toString().includes('läuft')) resolve();
  });
  server.on('exit', () => reject(new Error('Server konnte nicht starten')));
  setTimeout(() => reject(new Error('Server-Start-Timeout')), 5000);
});

try {
  // 1. Host erstellt Raum
  const host = await openSocket();
  sendJson({ socket: host, message: { type: 'host:create' } });
  const created = await waitFor({ socket: host, type: 'host:created' });
  if (!/^[A-Z2-9]{6}$/.test(created.code)) fail({ reason: `Ungültiger Raumcode: ${created.code}` });
  console.log(`✓ Raum erstellt: ${created.code}`);

  // 2. Viewer tritt mit Gerätenamen bei
  const viewer = await openSocket();
  sendJson({ socket: viewer, message: { type: 'viewer:join', code: created.code, name: 'Tablet Theke\u0007' } });
  const joined = await waitFor({ socket: viewer, type: 'viewer:joined' });
  const hostNotified = await waitFor({ socket: host, type: 'viewer:joined' });
  if (hostNotified.viewerId !== joined.viewerId) fail({ reason: 'Viewer-IDs stimmen nicht überein' });
  if (hostNotified.name !== 'Tablet Theke') fail({ reason: `Name nicht/falsch übermittelt: ${hostNotified.name}` });
  console.log(`✓ Viewer beigetreten: ${joined.viewerId} („${hostNotified.name}“, Steuerzeichen entfernt)`);

  // 2b. Viewer benennt sich um
  sendJson({ socket: viewer, message: { type: 'viewer:rename', name: 'Billard' } });
  const renamed = await waitFor({ socket: host, type: 'viewer:renamed' });
  if (renamed.viewerId !== joined.viewerId || renamed.name !== 'Billard') fail({ reason: 'Umbenennen fehlgeschlagen' });
  console.log('✓ Umbenennen wird an den Host weitergeleitet');

  // 3. Signaling Host -> Viewer (Offer) und zurück (Answer)
  sendJson({
    socket: host,
    message: { type: 'signal', to: joined.viewerId, payload: { sdp: { type: 'offer', sdp: 'fake' } } },
  });
  const offer = await waitFor({ socket: viewer, type: 'signal' });
  if (offer.from !== 'host' || offer.payload.sdp.type !== 'offer') fail({ reason: 'Offer kam nicht an' });
  sendJson({ socket: viewer, message: { type: 'signal', payload: { sdp: { type: 'answer', sdp: 'fake' } } } });
  const answer = await waitFor({ socket: host, type: 'signal' });
  if (answer.from !== joined.viewerId || answer.payload.sdp.type !== 'answer') fail({ reason: 'Answer kam nicht an' });
  console.log('✓ SDP-Austausch in beide Richtungen funktioniert');

  // 4. Falscher Raumcode
  const lost = await openSocket();
  sendJson({ socket: lost, message: { type: 'viewer:join', code: 'XXXXXX' } });
  const error = await waitFor({ socket: lost, type: 'error' });
  if (error.code !== 'room-not-found') fail({ reason: 'room-not-found fehlt' });
  console.log('✓ Unbekannter Raum wird abgelehnt');
  lost.close();

  // 5. Host trennt -> Viewer bekommt host:offline; Reclaim mit Token
  host.close();
  await waitFor({ socket: viewer, type: 'host:offline' });
  console.log('✓ Viewer wird über Host-Offline informiert');

  const host2 = await openSocket();
  sendJson({
    socket: host2,
    message: { type: 'host:reclaim', code: created.code, hostToken: created.hostToken },
  });
  const reclaimed = await waitFor({ socket: host2, type: 'host:created' });
  if (reclaimed.code !== created.code) fail({ reason: 'Reclaim lieferte falschen Raum' });
  const rejoinNotice = await waitFor({ socket: host2, type: 'viewer:joined' });
  if (rejoinNotice.viewerId !== joined.viewerId) fail({ reason: 'Bestehender Viewer fehlt nach Reclaim' });
  await waitFor({ socket: viewer, type: 'host:online' });
  console.log('✓ Host-Reclaim nach Reload funktioniert, Viewer-Liste bleibt erhalten');

  // 6. Reclaim mit fremdem Token wird abgelehnt
  const thief = await openSocket();
  sendJson({ socket: thief, message: { type: 'host:reclaim', code: created.code, hostToken: 'f'.repeat(32) } });
  const denied = await waitFor({ socket: thief, type: 'error' });
  if (denied.code !== 'room-not-found') fail({ reason: 'Fremder Token wurde akzeptiert!' });
  console.log('✓ Reclaim mit falschem Token wird abgelehnt');
  thief.close();

  // 7. Reclaim eines nicht (mehr) existierenden Raums legt ihn mit gleichem Code neu an
  //    (Server-Neustart-Szenario: Host bringt Code + Token aus localStorage mit)
  const phoenix = await openSocket();
  const phoenixToken = 'ab'.repeat(16);
  sendJson({ socket: phoenix, message: { type: 'host:reclaim', code: 'ZZZZ99', hostToken: phoenixToken } });
  const revived = await waitFor({ socket: phoenix, type: 'host:created' });
  if (revived.code !== 'ZZZZ99' || revived.hostToken !== phoenixToken) {
    fail({ reason: 'Raum wurde nach Neustart nicht mit gleichem Code neu angelegt' });
  }
  console.log('✓ Raum-Code übersteht Server-Neustart (Reclaim legt Raum neu an)');
  phoenix.close();

  host2.close();
  viewer.close();
  console.log('\nAlle Smoke-Tests bestanden.');
} catch (err) {
  fail({ reason: err.message });
} finally {
  server.kill();
}
