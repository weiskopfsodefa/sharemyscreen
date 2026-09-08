import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
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
    loadSDK: async () => ({ Room, RoomEvent: new Proxy({}, { get: (_, key) => key }), Track: { Source: { ScreenShare: 'screen_share' } } }),
    ...options,
  });
  return { client, rooms };
}

test('Host publishes once without simulcast or public ICE servers, independent of viewer count', async () => {
  const track = {};
  const s = setup({ track, publishOptions: { degradationPreference: 'maintain-framerate' } });
  s.client.start(); await flush(); const room = s.rooms[0];
  for (let i = 0; i < 10; i++) room.emit('ParticipantConnected');
  assert.equal(s.rooms.length, 1); assert.equal(room.publication.track, track);
  assert.equal(room.options.stopLocalTrackOnUnpublish, false, 'SDK disconnect must preserve the host capture for retry');
  assert.equal(room.publication.opts.simulcast, false);
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

test('Quality changes scale the native source and preserve sender parameters and reconnect budget', async () => {
  let params = { transactionId: 'keep', encodings: [{ rid: 'video', active: true }] };
  const sender = { getParameters: () => structuredClone(params), setParameters: async next => { params = next; } };
  const capture = { getSettings: () => ({ height: 1440 }) };
  const s = setup({ track: capture, publishOptions: {} });
  s.client.start(); await flush();
  s.client.localTrack = { sender };
  assert.equal(await s.client.setQuality({ height: 720, maxFramerate: 30, maxBitrate: 2000000 }), true);
  assert.equal(params.encodings[0].scaleResolutionDownBy, 2);
  assert.equal(params.encodings[0].rid, 'video');
  assert.equal(params.transactionId, 'keep');
  assert.equal(await s.client.setQuality({ height: null, maxFramerate: 30, maxBitrate: 6000000 }), true);
  assert.equal(params.encodings[0].scaleResolutionDownBy, 1);
  assert.equal(s.client.publishOptions.screenShareEncoding.maxBitrate, 6000000);
  params.encodings[0].scaleResolutionDownBy = 99;
  s.rooms[0].emit('Reconnected'); await flush();
  assert.equal(params.encodings[0].scaleResolutionDownBy, 1, 'SDK reconnect reapplies the last quality');
  sender.setParameters = async () => { throw new Error('Encoder rejected change'); };
  await assert.rejects(s.client.setQuality({ height: 540, maxFramerate: 15, maxBitrate: 700000 }));
  assert.equal(s.client.quality.height, null, 'Rejected change must not replace the applied target');
  s.client.stop();
  assert.equal(await s.client.setQuality({ height: 720, maxFramerate: 30, maxBitrate: 2000000 }), false);
});

test('Stopping during an encoder update discards its late result', async () => {
  let finish;
  const s = setup({ track: { getSettings: () => ({ height: 1440 }) }, publishOptions: {} });
  s.client.start(); await flush();
  s.client.localTrack = { sender: {
    getParameters: () => ({ encodings: [{}] }),
    setParameters: () => new Promise(resolve => { finish = resolve; }),
  } };
  const pending = s.client.setQuality({ height: 720, maxFramerate: 30, maxBitrate: 2000000 });
  s.client.stop(); finish();
  assert.equal(await pending, false);
  assert.equal(s.client.quality, undefined);
});
