import test from 'node:test';
import assert from 'node:assert/strict';
import { createMediaAuto, advanceMediaAuto } from '../public/js/media-auto.js';
const cleanUntil = (auto, start, end) => { for (let now = start; now < end; now += 3000) advanceMediaAuto(auto, sample(now)); };
const sample = (now, overrides = {}) => ({ now, upload: { framesPerSecond: 30, bitrate: 2000000, qualityLimitationReason: 'none' },
  receivers: [{ id: 'one', at: now, stats: { bitrate: 2000000, framesPerSecond: 30, fractionLost: 0 } }], ...overrides });

test('Stable receivers climb from 720p through 1080p to native after sustained clean periods', () => {
  const auto = createMediaAuto('motion');
  assert.equal(auto.ladder[auto.index].height, 720);
  assert.equal(advanceMediaAuto(auto, sample(1000)), false);
  cleanUntil(auto, 4000, 30000);
  assert.equal(advanceMediaAuto(auto, sample(30000)), false);
  assert.equal(advanceMediaAuto(auto, sample(31000)), true);
  assert.equal(auto.ladder[auto.index].height, 1080);
  cleanUntil(auto, 34000, 61000);
  assert.equal(advanceMediaAuto(auto, sample(61000)), true);
  assert.equal(auto.ladder[auto.index].height, null);
  assert.equal(advanceMediaAuto(auto, sample(91000)), false);
});

test('One slow tablet reduces the shared stream, failed upgrade probes back off', () => {
  const auto = createMediaAuto('motion');
  cleanUntil(auto, 0, 30000); advanceMediaAuto(auto, sample(30000));
  const bad = now => sample(now, { receivers: [...sample(now).receivers,
    { id: 'slow', at: now, stats: { bitrate: 1000000, framesPerSecond: 12, fractionLost: .1 } }] });
  assert.equal(advanceMediaAuto(auto, bad(33000)), false);
  assert.equal(advanceMediaAuto(auto, bad(36000)), true);
  assert.equal(auto.ladder[auto.index].height, 720);
  assert.equal(auto.retryMs, 60000);
  cleanUntil(auto, 39000, 69000);
  assert.equal(advanceMediaAuto(auto, sample(69000)), false);
  cleanUntil(auto, 72000, 96000);
  assert.equal(advanceMediaAuto(auto, sample(96000)), true);
});

test('Priority determines reduction order and duplicate samples cannot trigger a reduction', () => {
  for (const mode of ['motion', 'detail']) {
    const auto = createMediaAuto(mode);
    auto.index = auto.ladder.findIndex(s => s.height === 1080 && s.maxFramerate === 30);
    const bad = sample(0); bad.upload.qualityLimitationReason = 'cpu';
    assert.equal(advanceMediaAuto(auto, bad), false);
    assert.equal(advanceMediaAuto(auto, bad), false);
    assert.equal(advanceMediaAuto(auto, { ...bad, now: 3000, receivers: bad.receivers.map(r => ({ ...r, at: 3000 })) }), true);
    const target = auto.ladder[auto.index];
    assert.deepEqual([target.height, target.maxFramerate], mode === 'motion' ? [720, 30] : [1080, 15]);
  }
});

test('Missing or stale measurements interrupt the clean window; idle screens are not failures', () => {
  for (const missing of [{ receivers: [] }, { upload: null }, { receivers: [{ id: 'one', at: 0, stats: sample(0).receivers[0].stats }] }]) {
    const auto = createMediaAuto('motion'); advanceMediaAuto(auto, sample(0));
    assert.equal(advanceMediaAuto(auto, sample(30000, missing)), false);
    assert.equal(auto.cleanSince, null);
    assert.equal(advanceMediaAuto(auto, sample(33000)), false);
  }
  const auto = createMediaAuto('motion');
  for (const now of [0, 3000, 6000]) {
    const idle = sample(now); idle.upload.framesPerSecond = 0; idle.upload.bitrate = 0;
    idle.receivers[0].stats.framesPerSecond = 0; idle.receivers[0].stats.bitrate = 0;
    assert.equal(advanceMediaAuto(auto, idle), false);
  }
  assert.equal(auto.ladder[auto.index].height, 720);
});
