import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import WebSocket from 'ws';
import { TokenVerifier } from 'livekit-server-sdk';
import { mediaConfig, isPrivateIPv4 } from '../media-config.js';

const secret = 'test-secret-with-at-least-thirty-two-characters';
function client(url) {
  const ws = new WebSocket(url);
  const inbox = [];
  const waiters = [];
  ws.on('message', raw => {
    const message = JSON.parse(raw);
    const index = waiters.findIndex(w => w.type === message.type);
    if (index < 0) inbox.push(message); else waiters.splice(index, 1)[0].resolve(message);
  });
  return {
    ws, send: message => ws.send(JSON.stringify(message)),
    wait(type) {
      const index = inbox.findIndex(m => m.type === type);
      if (index >= 0) return Promise.resolve(inbox.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), 4000);
        waiters.push({ type, resolve: message => { clearTimeout(timer); resolve(message); } });
      });
    },
  };
}

test('LAN configuration rejects public or malformed addresses', () => {
  for (const ip of ['127.0.0.1', '8.8.8.8', 'example.com', '192.168.1.999']) assert.equal(isPrivateIPv4(ip), false);
  assert.equal(isPrivateIPv4('192.168.1.4'), true);
  assert.equal(mediaConfig({}), null);
  assert.throws(() => mediaConfig({ LOCAL_MEDIA_IP: '192.168.1.4' }));
});

test('Optional media signaling grants only the host publishing rights, isolates sessions and preserves direct mode', async t => {
  const server = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: '3298', LOCAL_MEDIA_IP: '192.168.1.4', LIVEKIT_API_KEY: 'testkey', LIVEKIT_API_SECRET: secret, HOST_TOKEN_SECRET: secret }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => server.kill());
  await Promise.race([once(server.stdout, 'data'), once(server, 'exit').then(() => { throw new Error('Server failed to start'); })]);
  const host = client('ws://127.0.0.1:3298/ws'); const viewer = client('ws://127.0.0.1:3298/ws');
  t.after(() => { host.ws.terminate(); viewer.ws.terminate(); });
  await Promise.all([once(host.ws, 'open'), once(viewer.ws, 'open')]);
  host.send({ type: 'host:create' });
  const created = await host.wait('host:created');
  assert.equal(created.media.available, true);
  assert.equal(created.media.publicOrigin, 'http://192.168.1.4:3298');
  viewer.send({ type: 'viewer:join', code: created.code });
  const joined = await viewer.wait('viewer:joined'); await host.wait('viewer:joined');
  assert.equal(joined.transport.mode, 'direct');
  viewer.send({ type: 'host:transport', mode: 'livekit', requestId: 'unauthorized' });
  assert.match((await viewer.wait('reply')).error, /Host/);
  host.send({ type: 'host:transport', mode: 'livekit', requestId: 'mode' });
  const { transport } = await host.wait('reply');
  assert.equal((await viewer.wait('room:transport')).transport.session, transport.session);
  // Wrong-session and host-origin telemetry must not reach the host.
  viewer.send({ type: 'media:stats', session: 'old-session', stats: { framesPerSecond: 999 } });
  host.send({ type: 'media:stats', session: transport.session, stats: { framesPerSecond: 888 } });
  viewer.send({ type: 'media:stats', viewerId: 'spoofed', session: transport.session,
    stats: { framesPerSecond: 30, bitrate: 2000000, frameWidth: '<img>', arbitrary: 'ignored' } });
  const measurement = await host.wait('media:stats');
  assert.equal(measurement.viewerId, joined.viewerId);
  assert.equal(measurement.stats.framesPerSecond, 30);
  assert.equal(measurement.stats.bitrate, 2000000);
  assert.equal(measurement.stats.frameWidth, null);
  assert.equal(measurement.stats.arbitrary, undefined);
  host.send({ type: 'media:token', session: transport.session, requestId: 'host-token' });
  viewer.send({ type: 'media:token', session: transport.session, role: 'host', requestId: 'viewer-token' });
  const verifier = new TokenVerifier('testkey', secret);
  const h = await verifier.verify((await host.wait('reply')).token);
  const v = await verifier.verify((await viewer.wait('reply')).token);
  for (const claims of [h, v]) {
    assert.equal(claims.roomConfig.minPlayoutDelay, 500);
    assert.equal(claims.roomConfig.maxPlayoutDelay, 500);
  }
  assert.equal(h.video.canPublish, true); assert.deepEqual(h.video.canPublishSources, ['screen_share']);
  assert.equal(v.video.canPublish, false); assert.equal(v.video.canSubscribe, true);
  assert.equal(v.sub, joined.viewerId); assert.equal(v.video.room, h.video.room);
  assert.equal(h.video.canPublishData, false);
  viewer.send({ type: 'media:token', session: 'old-session', requestId: 'stale' });
  assert.ok((await viewer.wait('reply')).error);
  host.send({ type: 'host:transport', mode: 'direct', requestId: 'stop' });
  await host.wait('reply'); assert.equal((await viewer.wait('room:transport')).transport.mode, 'direct');
  host.send({ type: 'signal', to: joined.viewerId, payload: { sdp: 'direct-offer' } });
  assert.equal((await viewer.wait('signal')).payload.sdp, 'direct-offer');
  assert.equal((await fetch('http://127.0.0.1:3298/vendor/livekit.mjs')).status, 200);
});
