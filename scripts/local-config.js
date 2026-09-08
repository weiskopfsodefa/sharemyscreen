import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { isPrivateIPv4 } from '../media-config.js';

export function localAddresses(interfaces = os.networkInterfaces()) {
  return Object.entries(interfaces).flatMap(([name, entries]) => (entries || [])
    .filter(entry => entry.family === 'IPv4' && !entry.internal && isPrivateIPv4(entry.address))
    .map(entry => ({ name, address: entry.address })));
}

export function prepareLocalConfig({ dir, ip }) {
  if (!isPrivateIPv4(ip)) throw new Error('Eine private IPv4-Adresse wird benötigt.');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const secretFile = path.join(dir, 'secrets.json');
  let secrets;
  try { secrets = JSON.parse(fs.readFileSync(secretFile, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    secrets = { key: `sms${crypto.randomBytes(8).toString('hex')}`, secret: crypto.randomBytes(32).toString('hex'), host: crypto.randomBytes(32).toString('hex') };
    fs.writeFileSync(secretFile, JSON.stringify(secrets), { mode: 0o600 });
  }
  if (!secrets.key || !secrets.secret || !secrets.host) throw new Error('Lokale Konfiguration ist beschädigt.');
  const configPath = path.join(dir, 'livekit.yaml');
  const config = {
    port: 7880, bind_addresses: ['127.0.0.1', ip],
    rtc: { node_ip: ip, use_external_ip: false, tcp_port: 7881, udp_port: 7882, stun_servers: [] },
    keys: { [secrets.key]: secrets.secret },
    room: { empty_timeout: 60, departure_timeout: 10, max_participants: 21 },
    turn: { enabled: false },
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  return { configPath, secrets };
}
