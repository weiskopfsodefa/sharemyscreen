import test from 'node:test';
import assert from 'node:assert/strict';
import { receiverStats, sanitizeMediaStats } from '../public/js/media-stats.js';

const report = (overrides = {}) => new Map([
  ['video', { id: 'video', ssrc: 1, type: 'inbound-rtp', kind: 'video', timestamp: 1000,
    bytesReceived: 1000, framesDecoded: 30, packetsReceived: 100, packetsLost: 0,
    frameWidth: 1280, frameHeight: 720, transportId: 'transport', ...overrides }],
  ['transport', { id: 'transport', selectedCandidatePairId: 'pair' }],
  ['pair', { id: 'pair', type: 'candidate-pair', currentRoundTripTime: 0.012 }],
]);

test('Receiver statistics measure decoded frames and interval loss rather than lifetime totals', () => {
  const first = receiverStats(report());
  assert.equal(first.stats.bitrate, null);
  const next = receiverStats(report({ timestamp: 4000, bytesReceived: 751000, framesDecoded: 120, packetsReceived: 397, packetsLost: 3 }), first);
  assert.deepEqual(next.stats, { bitrate: 2000000, framesPerSecond: 30, frameWidth: 1280, frameHeight: 720, fractionLost: 0.01, roundTripTime: 0.012 });
  const frozen = receiverStats(report({ timestamp: 7000, bytesReceived: 751000, framesDecoded: 120, packetsReceived: 397, packetsLost: 3 }), next);
  assert.equal(frozen.stats.framesPerSecond, 0);
  assert.equal(frozen.stats.bitrate, 0);
});

test('Resets, replaced streams and unavailable counters never invent rates', () => {
  const first = receiverStats(report());
  for (const overrides of [{ timestamp: 1000 }, { timestamp: 4000, ssrc: 2 }, { timestamp: 4000, bytesReceived: 0, framesDecoded: 0 }]) {
    const stats = receiverStats(report(overrides), first).stats;
    assert.equal(stats.bitrate, null);
    assert.equal(stats.framesPerSecond, null);
  }
  assert.equal(receiverStats(new Map()), null);
  assert.equal(receiverStats(undefined), null);
});

test('Telemetry allowlist rejects HTML, nonfinite values and out-of-range metrics', () => {
  assert.deepEqual(sanitizeMediaStats({ bitrate: '<img>', framesPerSecond: Infinity, frameWidth: -1,
    frameHeight: 999999, fractionLost: 2, roundTripTime: NaN, arbitrary: 'no' }), {
    bitrate: null, framesPerSecond: null, frameWidth: null, frameHeight: null, fractionLost: null, roundTripTime: null,
  });
  assert.equal(sanitizeMediaStats(null), null);
});
