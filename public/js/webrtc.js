export const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

export function createPeerConnection() {
  return new RTCPeerConnection({ iceServers: ICE_SERVERS });
}

/**
 * Liest den ausgehandelten Verbindungsweg und Qualitätswerte aus den WebRTC-Stats.
 * path: 'lokal' (beide Kandidaten im LAN), 'internet' (direkt, aber über STUN/öffentliche
 * Adresse) oder 'relay' (TURN – Video läuft über einen Server, in der Kneipe unerwünscht).
 */
export async function readConnectionStats({ pc }) {
  const report = await pc.getStats();
  const byId = new Map();
  report.forEach((entry) => byId.set(entry.id, entry));

  let pair = null;
  report.forEach((entry) => {
    if (entry.type === 'transport' && entry.selectedCandidatePairId) {
      pair = byId.get(entry.selectedCandidatePairId) ?? pair;
    }
  });
  if (!pair) {
    report.forEach((entry) => {
      if (entry.type === 'candidate-pair' && entry.nominated && entry.state === 'succeeded') {
        pair = entry;
      }
    });
  }

  const local = pair ? byId.get(pair.localCandidateId) : null;
  const remote = pair ? byId.get(pair.remoteCandidateId) : null;

  const stats = {
    path: null,
    roundTripTime: pair?.currentRoundTripTime ?? null,
    bytesSent: null,
    bytesReceived: null,
    fractionLost: null,
    framesPerSecond: null,
    qualityLimitationReason: null,
    timestamp: performance.now(),
  };

  if (local && remote) {
    const types = [local.candidateType, remote.candidateType];
    if (types.includes('relay')) {
      stats.path = 'relay';
    } else if (types.every((type) => type === 'host' || type === 'prflx')) {
      stats.path = 'lokal';
    } else {
      stats.path = 'internet';
    }
  }

  report.forEach((entry) => {
    if (entry.kind !== 'video') return;
    if (entry.type === 'outbound-rtp') {
      stats.bytesSent = entry.bytesSent ?? null;
      stats.framesPerSecond = entry.framesPerSecond ?? stats.framesPerSecond;
      stats.qualityLimitationReason = entry.qualityLimitationReason ?? null;
    }
    if (entry.type === 'inbound-rtp') {
      stats.bytesReceived = entry.bytesReceived ?? null;
      stats.framesPerSecond = entry.framesPerSecond ?? stats.framesPerSecond;
    }
    if (entry.type === 'remote-inbound-rtp') {
      stats.fractionLost = entry.fractionLost ?? null;
      stats.roundTripTime = stats.roundTripTime ?? entry.roundTripTime ?? null;
    }
  });

  return stats;
}

export function formatBitrate({ bits }) {
  if (bits == null) return '–';
  if (bits >= 1_000_000) return `${(bits / 1_000_000).toFixed(1)} Mbit/s`;
  return `${Math.round(bits / 1000)} kbit/s`;
}

export const PATH_LABELS = {
  lokal: { text: 'LOKAL', css: 'ok', hint: 'Video läuft direkt im WLAN' },
  internet: { text: 'DIREKT', css: 'warn', hint: 'Direktverbindung über öffentliche Adresse' },
  relay: { text: 'RELAY ⚠', css: 'bad', hint: 'Video läuft über einen Internet-Server!' },
};
