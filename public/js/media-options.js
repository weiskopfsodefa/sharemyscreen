export const PLAYOUT_TARGET_MS = 500;

// The source is the top layer. Only add smaller layers, in ascending order.
// Match the source aspect ratio, including portrait and ultrawide captures.
export function mediaLayers({ width, height }, top = {}, mode = 'motion') {
  if (!(width > 0 && height > 0)) return [];
  const shortEdge = Math.min(width, height);
  const fps = Math.min(top.maxFramerate || 30, mode === 'detail' ? 15 : 30);
  return [360, 720].filter(edge => edge < shortEdge).map(edge => ({
    width: Math.max(2, Math.round(width * edge / shortEdge / 2) * 2),
    height: Math.max(2, Math.round(height * edge / shortEdge / 2) * 2),
    maxFramerate: fps,
    maxBitrate: Math.min(top.maxBitrate || 6_000_000, (edge === 360 ? 600_000 : 2_000_000) * fps / 30),
  }));
}

// Browser hints, not a guarantee of exact end-to-end latency. LiveKit also sends
// the room's playout-delay hint over RTP for browsers without these JS setters.
export function applyPlayoutTarget(receiver) {
  if (!receiver) return false;
  try {
    if ('jitterBufferTarget' in receiver) {
      receiver.jitterBufferTarget = PLAYOUT_TARGET_MS;
      return true;
    }
  } catch { /* Try the older API when a browser rejects the newer setter. */ }
  try {
    if ('playoutDelayHint' in receiver) {
      receiver.playoutDelayHint = PLAYOUT_TARGET_MS / 1000;
      return true;
    }
  } catch { /* Unsupported hints must never prevent video playback. */ }
  return false;
}
