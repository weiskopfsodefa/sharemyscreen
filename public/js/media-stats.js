// Shared allowlist: never forward arbitrary viewer content into the host UI.
export function sanitizeMediaStats(value) {
  if (!value || typeof value !== 'object') return null;
  const limits = { bitrate: 1e9, framesPerSecond: 1000, frameWidth: 32768, frameHeight: 32768, fractionLost: 1, roundTripTime: 120 };
  return Object.fromEntries(Object.entries(limits).map(([key, max]) => [key,
    typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= max ? value[key] : null,
  ]));
}

export function receiverStats(report, previous) {
  if (!report) return null;
  const entries = [...report.values()];
  const inbound = entries.find(e => e.type === 'inbound-rtp' && (e.kind ?? e.mediaType) === 'video');
  if (!inbound) return null;
  const transport = entries.find(e => e.id === inbound.transportId);
  const pair = entries.find(e => e.id === transport?.selectedCandidatePairId)
    ?? entries.find(e => e.type === 'candidate-pair' && e.state === 'succeeded' && e.nominated);
  const seconds = previous && previous.id === inbound.id && previous.ssrc === inbound.ssrc
    ? (inbound.timestamp - previous.timestamp) / 1000 : 0;
  const delta = key => seconds > 0 && Number.isFinite(inbound[key]) && Number.isFinite(previous[key])
    && inbound[key] >= previous[key] ? inbound[key] - previous[key] : null;
  const bytes = delta('bytesReceived');
  const frames = delta('framesDecoded');
  const lost = delta('packetsLost');
  const received = delta('packetsReceived');
  return { ...inbound, stats: sanitizeMediaStats({
    bitrate: bytes == null ? null : bytes * 8 / seconds,
    framesPerSecond: frames == null ? inbound.framesPerSecond : frames / seconds,
    frameWidth: inbound.frameWidth, frameHeight: inbound.frameHeight,
    fractionLost: lost != null && received != null && lost + received > 0 ? lost / (lost + received) : null,
    roundTripTime: pair?.currentRoundTripTime,
  }) };
}
