import os from 'node:os';
import { checkLiveKit, printLiveKitCheck } from './livekit-check.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isPrivateIPv4 } from '../media-config.js';

const installation = checkLiveKit();
printLiveKitCheck(installation);
if (!installation.ok) process.exit(1);

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const addresses = [...new Set(Object.values(os.networkInterfaces()).flat()
  .filter(entry => entry.family === 'IPv4' && !entry.internal && isPrivateIPv4(entry.address))
  .map(entry => entry.address))];
const ip = process.env.LOCAL_MEDIA_IP || (addresses.length === 1 ? addresses[0] : null);
if (!ip || !addresses.includes(ip)) {
  console.error('Bitte die LAN-Adresse des Host-Laptops mit LOCAL_MEDIA_IP angeben.');
  console.error(`Gefundene Adressen: ${addresses.join(', ') || 'keine – WLAN/LAN verbinden'}`);
  process.exit(1);
}
const dir = path.join(root, '.local');
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const secretFile = path.join(dir, 'secrets.json');
let secrets;
try { secrets = JSON.parse(fs.readFileSync(secretFile, 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  secrets = { key: `sms${crypto.randomBytes(8).toString('hex')}`, secret: crypto.randomBytes(32).toString('hex'), host: crypto.randomBytes(32).toString('hex') };
  fs.writeFileSync(secretFile, JSON.stringify(secrets), { mode: 0o600 });
}
const configPath = path.join(dir, 'livekit.yaml');
// No external IP discovery, TURN or cloud service. RTC clients also disable STUN.
const config = {
  port: 7880, bind_addresses: ['127.0.0.1', ip],
  rtc: { node_ip: ip, use_external_ip: false, tcp_port: 7881, udp_port: 7882, stun_servers: [] },
  keys: { [secrets.key]: secrets.secret },
  room: { empty_timeout: 60, departure_timeout: 10, max_participants: 21 },
  turn: { enabled: false },
};
// JSON is a YAML subset and avoids platform-dependent quoting of secrets/paths.
fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
let app;
let stopping = false;
const livekit = spawn(installation.binary, ['--config', configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  app?.kill(); livekit.kill();
  process.exitCode = code;
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
livekit.on('error', error => {
  console.error(`LiveKit konnte nicht gestartet werden: ${error.message}`);
  console.error('macOS: brew install livekit | Windows: livekit-server.exe installieren und LIVEKIT_BIN setzen.');
  stop(1);
});
livekit.on('exit', code => { if (!stopping) { console.error('LiveKit beendet. Starter erneut ausführen.'); stop(code || 1); } });
// Startup diagnostics may include server API keys: keep raw logs local, not in browser/UI.
const log = fs.createWriteStream(path.join(dir, 'livekit.log'), { flags: 'w', mode: 0o600 });
livekit.stdout.pipe(log, { end: false }); livekit.stderr.pipe(log, { end: false });

for (let attempt = 0; attempt < 40 && !stopping; attempt++) {
  try {
    const response = await fetch('http://127.0.0.1:7880/', { signal: AbortSignal.timeout(500) });
    if (response.ok) {
      const port = process.env.PORT || '3210';
      app = spawn(process.execPath, ['server.js'], {
        cwd: root, stdio: 'inherit',
        env: { ...process.env, PORT: port, LOCAL_MEDIA_IP: ip, LIVEKIT_API_KEY: secrets.key, LIVEKIT_API_SECRET: secrets.secret, HOST_TOKEN_SECRET: secrets.host },
      });
      app.on('error', () => stop(1));
      app.on('exit', code => { if (!stopping) stop(code || 1); });
      console.log(`Host: ${process.env.TLS_CERT ? 'https' : 'http'}://localhost:${port}/host`);
      console.log(`Tablets: QR-Code der lokalen Host-Seite scannen (LAN ${ip}).`);
      break;
    }
  } catch { /* wait for LiveKit to bind */ }
  await new Promise(resolve => setTimeout(resolve, 250));
}
if (!app && !stopping) { console.error('LiveKit nicht bereit. Details stehen in .local/livekit.log.'); stop(1); }
