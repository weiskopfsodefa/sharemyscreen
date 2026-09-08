const step = (height, maxFramerate, maxBitrate) => ({ height, maxFramerate, maxBitrate, label: `${height ? `${height}p` : 'Nativ'} / ${maxFramerate} FPS` });
export const MEDIA_LADDERS = {
  motion: [step(null, 30, 6_000_000), step(1080, 30, 4_000_000), step(720, 30, 2_000_000), step(540, 30, 1_200_000), step(540, 15, 700_000)],
  detail: [step(null, 30, 6_000_000), step(null, 15, 4_000_000), step(1080, 30, 4_000_000), step(1080, 15, 2_500_000), step(720, 30, 2_000_000), step(720, 15, 1_200_000), step(540, 15, 700_000)],
};

export function createMediaAuto(mode) {
  const ladder = MEDIA_LADDERS[mode];
  return { ladder, index: ladder.findIndex(s => s.height === 720 && s.maxFramerate === 30),
    cleanSince: null, badSamples: 0, cooldown: 0, retryMs: 30_000, lastUp: -Infinity, sampleKey: null };
}

// Receivers report every 3 s. Never count the same report twice, or interpret
// missing telemetry as proof of spare capacity. Low bitrate on idle screens
// alone is not a congestion signal; higher levels are probed with backoff.
export function advanceMediaAuto(auto, { now, upload, receivers }) {
  const available = upload && upload.bitrate != null && receivers.length && receivers.every(r => r.stats && now - r.at < 10_000
    && r.stats.bitrate != null && r.stats.framesPerSecond != null);
  if (!available) { auto.cleanSince = null; auto.badSamples = 0; return false; }
  const members = receivers.map(r => r.id).sort().join('|');
  if (auto.members !== members || now - (auto.lastSampleAt ?? now) > 10_000) {
    auto.cleanSince = null; auto.badSamples = 0;
  }
  auto.members = members;
  const key = receivers.map(r => `${r.id}:${r.at}`).sort().join('|');
  if (key === auto.sampleKey) return false;
  auto.sampleKey = key;
  auto.lastSampleAt = now;
  const preset = auto.ladder[auto.index];
  const bad = upload.qualityLimitationReason === 'cpu'
    || (upload.qualityLimitationReason === 'bandwidth' && upload.bitrate != null && upload.bitrate < preset.maxBitrate * 0.6)
    || receivers.some(r => r.stats.fractionLost > 0.03
      || (upload.framesPerSecond > 10 && r.stats.framesPerSecond < upload.framesPerSecond * 0.7));
  if (bad) {
    auto.cleanSince = null;
    if (++auto.badSamples < 2 || auto.index === auto.ladder.length - 1) return false;
    auto.index++;
    auto.badSamples = 0;
    auto.retryMs = now - auto.lastUp < 60_000 ? Math.min(auto.retryMs * 2, 300_000) : 30_000;
    auto.cooldown = now + auto.retryMs;
    return true;
  }
  auto.badSamples = 0;
  auto.cleanSince ??= now;
  if (auto.index > 0 && now - auto.cleanSince >= 30_000 && now >= auto.cooldown) {
    auto.index--;
    auto.cleanSince = now;
    auto.lastUp = now;
    return true;
  }
  return false;
}
