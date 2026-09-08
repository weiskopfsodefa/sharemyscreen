import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaLayers, applyPlayoutTarget } from '../public/js/media-options.js';

test('Simulcast never duplicates the source or upscales small captures', () => {
  assert.deepEqual(mediaLayers({ width: 640, height: 360 }), []);
  assert.deepEqual(mediaLayers({}), []);
  const layers = mediaLayers({ width: 1280, height: 720 }, { maxFramerate: 15, maxBitrate: 1200000 });
  assert.deepEqual(layers, [{ width: 640, height: 360, maxFramerate: 15, maxBitrate: 300000 }]);
});

test('Layer sizes preserve portrait and ultrawide aspect ratios and priority', () => {
  for (const [width, height] of [[1080, 1920], [3440, 1440]]) {
    const layers = mediaLayers({ width, height }, { maxFramerate: 30 }, 'detail');
    assert.equal(layers.length, 2);
    for (const layer of layers) {
      assert.ok(Math.abs(layer.width / layer.height - width / height) < 0.005);
      assert.ok(layer.width < width && layer.height < height);
      assert.equal(layer.maxFramerate, 15);
    }
  }
  assert.equal(mediaLayers({ width: 1920, height: 1080 })[0].maxFramerate, 30);
});

test('Playout hints use the correct units and safely tolerate missing or rejected APIs', () => {
  const modern = { jitterBufferTarget: null, playoutDelayHint: null };
  assert.equal(applyPlayoutTarget(modern), true);
  assert.equal(modern.jitterBufferTarget, 500);
  assert.equal(modern.playoutDelayHint, null);
  const legacy = { playoutDelayHint: null };
  assert.equal(applyPlayoutTarget(legacy), true);
  assert.equal(legacy.playoutDelayHint, 0.5);
  assert.equal(applyPlayoutTarget({}), false);
  assert.equal(applyPlayoutTarget(null), false);
  const rejecting = { set jitterBufferTarget(value) { throw new Error('unsupported'); }, playoutDelayHint: null };
  assert.equal(applyPlayoutTarget(rejecting), true);
  assert.equal(rejecting.playoutDelayHint, 0.5);
});
