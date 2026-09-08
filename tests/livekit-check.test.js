import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { checkLiveKit } from '../scripts/livekit-check.js';

const missing = { error: { code: 'ENOENT' } };
const installed = { status: 0, stdout: 'livekit-server version 1.13.6\n' };

test('Finds an existing server without starting a service; macOS searches Homebrew paths', () => {
  const calls = [];
  const result = checkLiveKit({ env: {}, platform: 'darwin', run: (binary, args, options) => {
    calls.push(binary); assert.deepEqual(args, ['--version']); assert.equal(options.timeout, 5000);
    return binary === '/opt/homebrew/bin/livekit-server' ? installed : missing;
  } });
  assert.equal(result.ok, true); assert.equal(result.version, '1.13.6');
  assert.deepEqual(calls, ['livekit-server', '/opt/homebrew/bin/livekit-server']);
});

test('An explicit executable path with spaces is preserved and never silently replaced', () => {
  const binary = 'C:\\Program Files\\LiveKit\\livekit-server.exe';
  const calls = [];
  const result = checkLiveKit({ env: { LIVEKIT_BIN: binary }, platform: 'win32', run: path => {
    calls.push(path); return missing;
  } });
  assert.equal(result.ok, false); assert.match(result.message, /LIVEKIT_BIN/);
  assert.deepEqual(calls, [binary]);
});

test('Distinguishes missing, broken, hanging and incorrect executables', () => {
  for (const failure of [missing, { error: { code: 'EACCES' } }, { error: { code: 'ETIMEDOUT' } },
    { status: 1, stderr: 'failure' }, { status: 0, stdout: 'lk version 2.0.0' }]) {
    assert.equal(checkLiveKit({ env: {}, platform: 'win32', run: () => failure }).ok, false);
  }
});

test('The starter fails installation preflight before choosing a LAN address or starting services', () => {
  const result = spawnSync(process.execPath, ['scripts/local-server.js'], {
    encoding: 'utf8', timeout: 10000,
    env: { ...process.env, LIVEKIT_BIN: '/does-not-exist/sharemyscreen-livekit-test', LOCAL_MEDIA_IP: 'invalid' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /LIVEKIT_BIN/);
  assert.doesNotMatch(result.stderr, /Gefundene Adressen/);
  assert.doesNotMatch(result.stdout, /Host: http/);
});
