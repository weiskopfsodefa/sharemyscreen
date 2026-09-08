import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { VideoPreset } from 'livekit-client';
import { MediaClient } from '../public/js/media-client.js';
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function setup(options = {}) {
  const rooms = [];
  class Room extends EventEmitter {
    constructor(options) {
      super(); this.options = options; rooms.push(this); this.remoteParticipants = new Map();
      this.localParticipant = { publishTrack: async (track, opts) => { this.publication = { track, opts }; } };
    }
    async connect(url, token, opts) { this.connection = {url, token, opts}; }
    async disconnect() { this.closed = true; this.emit('Disconnected'); }
  }
  const client = new MediaClient({
    credentials: async () => ({ url: 'ws://192.168.1.4:7880', token: 'test' }),
    loadSDK: async () => ({ Room, VideoPreset, RoomEvent: new Proxy({}, { get: (_, key) => key }), Track: { Source: { ScreenShare: 'screen_share' } } }),
    ...options,
  });
  return { client, rooms };
}

test('Host publishes once with simulcast and no public ICE servers, independent of viewer count', async () => {
  const track = { getSettings: () => ({ width: 2560, height: 1440 }) };
  const s = setup({ track, publishOptions: { degradationPreference: 'maintain-framerate' } });
  s.client.start(); await flush(); const room = s.rooms[0];
  for (let i = 0; i < 10; i++) room.emit('ParticipantConnected');
  assert.equal(s.rooms.length, 1); assert.equal(room.publication.track, track);
  assert.equal(room.options.stopLocalTrackOnUnpublish, false, 'SDK disconnect must preserve the host capture for retry');
  assert.equal(room.publication.opts.simulcast, true);
  assert.equal(room.options.dynacast, true);
  assert.deepEqual(room.options.adaptiveStream, { pixelDensity: 'screen' });
  assert.deepEqual(room.publication.opts.screenShareSimulcastLayers.map(p => p.height), [360, 720]);
  assert.equal(room.publication.opts.videoCodec, 'vp8');
  assert.equal(room.publication.opts.degradationPreference, 'maintain-framerate');
  assert.deepEqual(room.connection.opts.rtcConfig.iceServers, []);
  s.client.stop();
});

test('Stop cancels a pending connection and terminal disconnect requests fresh credentials', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolve;
  const pending = setup({ credentials: () => new Promise(r => { resolve = r; }) });
  pending.client.start(); await flush(); pending.client.stop(); resolve({ url: 'test', token: 'test' }); await flush();
  assert.equal(pending.rooms.length, 0);
  let requests = 0;
  const s = setup({ credentials: async () => { requests++; return { url: 'test', token: 'test' }; } });
  s.client.start(); await flush(); s.rooms[0].emit('Disconnected');
  t.mock.timers.tick(3000); await flush(); assert.equal(requests, 2);
  s.client.stop(); t.mock.timers.tick(3000); await flush(); assert.equal(requests, 2);
});

test('Viewer attaches only the host video and never publishes', async () => {
  const video = {}; let attachments = 0;
  const track = { kind: 'video', attach: element => { assert.equal(element, video); attachments++; }, detach() {} };
  const s = setup({ video }); s.client.start(); await flush();
  const room = s.rooms[0];
  room.emit('TrackSubscribed', track, {}, { identity: 'other-viewer' }); assert.equal(attachments, 0);
  room.emit('TrackSubscribed', track, {}, { identity: 'host' }); assert.equal(attachments, 1);
  assert.equal(room.publication, undefined);
  s.client.stop();
});

test('Playout target is reapplied to a replaced receiver after reconnect', async () => {
  const track = { kind: 'video', receiver: { jitterBufferTarget: null }, attach() {}, detach() {} };
  const s = setup({ video: {} }); s.client.start(); await flush();
  s.rooms[0].emit('TrackSubscribed', track, {}, { identity: 'host' });
  assert.equal(track.receiver.jitterBufferTarget, 500);
  track.receiver = { jitterBufferTarget: null };
  s.rooms[0].emit('Reconnected');
  assert.equal(track.receiver.jitterBufferTarget, 500);
  s.client.stop();
});

test('Terminal reconnect republishes the same simulcast profile without stopping capture', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = setup({ track: { getSettings: () => ({ width: 1920, height: 1080 }) },
    streamMode: 'detail', publishOptions: { screenShareEncoding: { maxBitrate: 4000000, maxFramerate: 30 } } });
  s.client.start(); await flush();
  const options = s.rooms[0].publication.opts;
  s.rooms[0].emit('Disconnected'); t.mock.timers.tick(3000); await flush();
  assert.deepEqual(s.rooms[1].publication.opts, options);
  assert.equal(options.screenShareSimulcastLayers[0].encoding.maxFramerate, 15);
  assert.equal(options.screenShareEncoding.maxFramerate, 30);
  s.client.stop();
});
