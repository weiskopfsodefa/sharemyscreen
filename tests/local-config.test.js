import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { localAddresses, prepareLocalConfig } from '../scripts/local-config.js';

test('App network choices exclude loopback, public and IPv6 addresses', () => {
  const list = localAddresses({ wifi: [
    { family: 'IPv4', internal: false, address: '192.168.1.20' },
    { family: 'IPv4', internal: true, address: '127.0.0.1' },
    { family: 'IPv4', internal: false, address: '8.8.8.8' },
    { family: 'IPv6', internal: false, address: 'fe80::1' },
  ] });
  assert.deepEqual(list, [{ name: 'wifi', address: '192.168.1.20' }]);
});

test('Installed app keeps secrets in writable user data, preserves rooms, and binds only the chosen LAN', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-app-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = prepareLocalConfig({ dir, ip: '192.168.1.20' });
  const second = prepareLocalConfig({ dir, ip: '10.0.0.4' });
  assert.deepEqual(first.secrets, second.secrets);
  const config = JSON.parse(fs.readFileSync(second.configPath));
  assert.deepEqual(config.bind_addresses, ['127.0.0.1', '10.0.0.4']);
  assert.equal(config.rtc.node_ip, '10.0.0.4');
  assert.deepEqual(config.rtc.stun_servers, []);
  assert.equal(config.rtc.use_external_ip, false);
  assert.throws(() => prepareLocalConfig({ dir, ip: 'example.com' }));
});
