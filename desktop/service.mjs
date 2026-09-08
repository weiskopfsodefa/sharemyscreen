// Runs in Electron's Node utility process: no separate Node installation.
import fs from 'node:fs';
import net from 'node:net';
import dgram from 'node:dgram';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { prepareLocalConfig, localAddresses } from '../scripts/local-config.js';
import { checkLiveKit } from '../scripts/livekit-check.js';

let livekit;
let shuttingDown = false;
let server;
const tell = message => process.parentPort.postMessage(message);
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server?.close();
  if (livekit && livekit.exitCode == null) {
    const exited = once(livekit, 'exit').catch(() => {});
    livekit.kill();
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2000))]);
    if (livekit.exitCode == null) livekit.kill('SIGKILL');
  }
  process.exit(0);
}
process.parentPort.on('message', event => { if (event.data === 'stop') shutdown(); });
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('uncaughtException', () => { tell({ type: 'error', message: 'Der lokale Dienst hat einen Fehler festgestellt. Bitte den Host erneut starten.' }); shutdown(); });
process.on('unhandledRejection', () => { tell({ type: 'error', message: 'Der lokale Dienst hat einen Fehler festgestellt. Bitte den Host erneut starten.' }); shutdown(); });
// If the application crashes, do not leave a background media server behind.
const owner = process.ppid;
setInterval(() => { try { process.kill(owner, 0); } catch { shutdown(); } }, 2000).unref();

async function checkPort(port, udp = false) {
  await new Promise((resolve, reject) => {
    const socket = udp ? dgram.createSocket('udp4') : net.createServer();
    socket.once('error', () => { try { socket.close(); } catch {} reject(new Error(`Port ${port} ist belegt oder nicht verfügbar. Bitte einen bereits laufenden lokalen Starter beenden.`)); });
    const ready = () => socket.close(resolve);
    if (udp) socket.bind(port, '0.0.0.0', ready); else socket.listen(port, '0.0.0.0', ready);
  });
}
try {
  const ip = process.env.LOCAL_MEDIA_IP;
  if (!localAddresses().some(entry => entry.address === ip)) throw new Error('Das gewählte Netzwerk ist nicht mehr verbunden. Bitte erneut auswählen.');
  const installation = checkLiveKit();
  if (!installation.ok) throw new Error('Der mitgelieferte Medienserver ist beschädigt oder fehlt. Bitte die Host-App neu installieren.');
  for (const port of [3210, 7880, 7881]) await checkPort(port);
  await checkPort(7882, true);
  const { configPath, secrets } = prepareLocalConfig({ dir: process.env.SMS_DATA_DIR, ip });
  Object.assign(process.env, { PORT: '3210', LIVEKIT_API_KEY: secrets.key, LIVEKIT_API_SECRET: secrets.secret, HOST_TOKEN_SECRET: secrets.host });
  // Do not inherit developer TLS overrides into an installed app.
  delete process.env.TLS_CERT; delete process.env.TLS_KEY; delete process.env.BIND_ADDRESS;
  const log = fs.createWriteStream(path.join(process.env.SMS_DATA_DIR, 'livekit.log'), { flags: 'w', mode: 0o600 });
  livekit = spawn(installation.binary, ['--config', configPath], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  livekit.stdout.pipe(log, { end: false }); livekit.stderr.pipe(log, { end: false });
  livekit.on('error', () => { tell({ type: 'error', message: 'Medienserver konnte nicht gestartet werden. Bitte die Host-App neu installieren.' }); shutdown(); });
  livekit.on('exit', () => { if (!shuttingDown) { tell({ type: 'error', message: 'Der Medienserver wurde beendet. Bitte den Host erneut starten.' }); shutdown(); } });
  let ready = false;
  for (let i = 0; i < 50 && !shuttingDown; i++) {
    try { ready = (await fetch('http://127.0.0.1:7880/', { signal: AbortSignal.timeout(400) })).ok; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!ready) throw new Error('Der Medienserver antwortet nicht. Bitte die Host-App erneut starten.');
  ({ server } = await import('../server.js'));
  if (!server.listening) await once(server, 'listening');
  tell({ type: 'ready', url: 'http://localhost:3210/host' });
} catch (error) {
  tell({ type: 'error', message: error.message });
  await shutdown();
}
