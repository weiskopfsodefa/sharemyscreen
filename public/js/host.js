import { SignalingClient } from './signaling.js';
import { createPeerConnection, readConnectionStats, formatBitrate, PATH_LABELS } from './webrtc.js';

// Es wird immer in nativer Auflösung gecaptured; das Preset steuert pro Verbindung
// die Encoder-Skalierung und Bitrate – Wechsel wirkt dadurch live, ohne Neustart.
const QUALITY_PRESETS = {
  auto: { label: 'Automatisch', auto: true },
  '540p15': { label: '540p · 15 fps – sparsam', height: 540, maxFramerate: 15, maxBitrate: 700_000 },
  '720p15': { label: '720p · 15 fps', height: 720, maxFramerate: 15, maxBitrate: 1_200_000 },
  '1080p15': { label: '1080p · 15 fps', height: 1080, maxFramerate: 15, maxBitrate: 2_500_000 },
  '1080p30': { label: '1080p · 30 fps', height: 1080, maxFramerate: 30, maxBitrate: 4_000_000 },
  source: { label: 'Quelle (nativ) · 30 fps', height: null, maxFramerate: 30, maxBitrate: 6_000_000 },
};
const DEFAULT_QUALITY = 'auto';

// Stufenleiter für „Automatisch“ – pro Tablet: bei Engpässen erst fps senken,
// dann Auflösung; bei Luft wieder hoch. Wirkt zusätzlich zur eingebauten
// WebRTC-Staukontrolle, die innerhalb einer Stufe bereits zuerst fps drosselt.
const AUTO_LADDER = [
  { ...QUALITY_PRESETS.source, label: 'nativ/30' },
  { label: 'nativ/15', height: null, maxFramerate: 15, maxBitrate: 4_000_000 },
  { ...QUALITY_PRESETS['1080p30'], label: '1080p/30' },
  { ...QUALITY_PRESETS['1080p15'], label: '1080p/15' },
  { label: '720p/30', height: 720, maxFramerate: 30, maxBitrate: 2_000_000 },
  { ...QUALITY_PRESETS['720p15'], label: '720p/15' },
  { ...QUALITY_PRESETS['540p15'], label: '540p/15' },
];
// Einstieg mittig: hoch genug für schnellen Aufstieg, ohne dass 10 Tablets
// gleichzeitig mit Maximal-Bitrate das WLAN fluten.
const AUTO_START_STEP = 2;
const AUTO_LOSS_LIMIT = 0.03;
const AUTO_BAD_SAMPLES = 2; // 2 Messungen à 2 s anhaltend schlecht → eine Stufe runter
const AUTO_CLEAN_MS = 30_000; // so lange sauber → eine Stufe rauf
const AUTO_RETRY_MS = 30_000;
const AUTO_RETRY_MAX_MS = 300_000;
const QUALITY_KEY = 'sms-quality';
const CAPTURE_VIDEO = { frameRate: { ideal: 30, max: 30 } };
const STATS_INTERVAL_MS = 2000;
const LAST_ROOM_KEY = 'sms-host:last';

function tokenKey({ code }) {
  return `sms-host:${code}`;
}

// Raum-Code aus der URL (/CODE), falls die Regie darüber geöffnet wurde.
const urlCode = (() => {
  const segment = location.pathname.split('/').pop().toUpperCase();
  return /^[A-Z0-9]{4,8}$/.test(segment) && segment !== 'HOST' ? segment : null;
})();

const ui = {
  roomCode: document.getElementById('room-code'),
  qrImg: document.getElementById('qr-img'),
  joinUrl: document.getElementById('join-url'),
  copyLink: document.getElementById('copy-link'),
  shareBtn: document.getElementById('share-btn'),
  stopBtn: document.getElementById('stop-btn'),
  qualitySelect: document.getElementById('quality-select'),
  qualityHint: document.getElementById('quality-hint'),
  preview: document.getElementById('preview'),
  onairBadge: document.getElementById('onair-badge'),
  onairText: document.getElementById('onair-text'),
  relayAlert: document.getElementById('relay-alert'),
  viewerRows: document.getElementById('viewer-rows'),
  viewerCount: document.getElementById('viewer-count'),
  wsLed: document.getElementById('ws-led'),
  wsStatus: document.getElementById('ws-status'),
};

const state = {
  code: null,
  hostToken: null,
  stream: null,
  /** @type {Map<string, {pc: RTCPeerConnection|null, label: string, status: string, stats: object|null, lastBytesSent: number|null, lastTimestamp: number|null}>} */
  viewers: new Map(),
  nextLabelNumber: 1,
};

// --- Raum anlegen / wiederherstellen ---

const signaling = new SignalingClient({
  onOpen: () => {
    const saved = state.hostToken ? { code: state.code, hostToken: state.hostToken } : readSavedRoom();
    if (saved) {
      state.code = saved.code;
      state.hostToken = saved.hostToken;
      signaling.send({ message: { type: 'host:reclaim', code: saved.code, hostToken: saved.hostToken } });
    } else {
      signaling.send({ message: { type: 'host:create' } });
    }
  },
  onMessage: ({ message }) => {
    const handler = MESSAGE_HANDLERS[message.type];
    if (handler) handler({ message });
  },
  onStatusChange: ({ status }) => {
    ui.wsLed.className = `led ${status === 'online' ? 'ok' : 'bad'}`;
    ui.wsStatus.textContent = status === 'online' ? 'Mit Server verbunden' : 'Server getrennt – verbinde neu…';
  },
});

function readSavedRoom() {
  const code = urlCode || localStorage.getItem(LAST_ROOM_KEY);
  if (!code) return null;
  const hostToken = localStorage.getItem(tokenKey({ code }));
  return hostToken ? { code, hostToken } : null;
}

const MESSAGE_HANDLERS = {
  'host:created': ({ message }) => {
    state.code = message.code;
    state.hostToken = message.hostToken;
    localStorage.setItem(tokenKey({ code: message.code }), message.hostToken);
    localStorage.setItem(LAST_ROOM_KEY, message.code);
    // Die Adresszeile des Hosts IST der Beitritts-Link.
    if (location.pathname !== `/${message.code}`) {
      history.replaceState(null, '', `/${message.code}`);
    }
    renderRoom();
  },
  'viewer:joined': ({ message }) =>
    addViewer({ viewerId: message.viewerId, name: message.name, needsOffer: message.needsOffer !== false }),
  'viewer:left': ({ message }) => removeViewer({ viewerId: message.viewerId }),
  'viewer:renamed': ({ message }) => {
    const viewer = state.viewers.get(message.viewerId);
    if (!viewer) return;
    viewer.name = message.name || null;
    renderViewers();
  },
  signal: ({ message }) => handleViewerSignal({ viewerId: message.from, payload: message.payload }),
  error: ({ message }) => {
    if (message.code === 'room-not-found') {
      // Reclaim abgelehnt (Token passt nicht) – gespeicherten Raum verwerfen, neuen anlegen.
      if (state.code) localStorage.removeItem(tokenKey({ code: state.code }));
      localStorage.removeItem(LAST_ROOM_KEY);
      state.code = null;
      state.hostToken = null;
      signaling.send({ message: { type: 'host:create' } });
    }
  },
};

function renderRoom() {
  const joinUrl = `${location.origin}/${state.code}`;
  ui.roomCode.textContent = state.code;
  ui.joinUrl.textContent = joinUrl;
  ui.copyLink.disabled = false;
  ui.shareBtn.disabled = false;
  ui.qrImg.src = `/qr.svg?text=${encodeURIComponent(joinUrl)}`;
  ui.qrImg.hidden = false;
}

ui.copyLink.addEventListener('click', async () => {
  await navigator.clipboard.writeText(`${location.origin}/${state.code}`);
  ui.copyLink.textContent = 'Kopiert ✓';
  setTimeout(() => (ui.copyLink.textContent = 'Link kopieren'), 1500);
});

// --- Bildschirm teilen ---

ui.shareBtn.addEventListener('click', startShare);
ui.stopBtn.addEventListener('click', stopShare);

async function startShare() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: CAPTURE_VIDEO });
  } catch {
    return; // Nutzer hat den Dialog abgebrochen.
  }
  state.stream = stream;
  const [videoTrack] = stream.getVideoTracks();
  videoTrack.contentHint = 'detail';
  videoTrack.addEventListener('ended', stopShare);

  ui.preview.srcObject = stream;
  ui.preview.classList.add('visible');
  ui.shareBtn.hidden = true;
  ui.stopBtn.hidden = false;
  ui.onairBadge.classList.add('onair');
  ui.onairText.textContent = 'ON AIR';

  for (const viewerId of state.viewers.keys()) {
    connectViewer({ viewerId });
  }
}

function stopShare() {
  state.stream?.getTracks().forEach((track) => track.stop());
  state.stream = null;
  for (const viewer of state.viewers.values()) {
    viewer.pc?.close();
    viewer.pc = null;
    viewer.status = 'wartet';
    viewer.stats = null;
  }
  ui.preview.srcObject = null;
  ui.preview.classList.remove('visible');
  ui.shareBtn.hidden = false;
  ui.stopBtn.hidden = true;
  ui.onairBadge.classList.remove('onair');
  ui.onairText.textContent = 'Bereit';
  renderViewers();
}

// --- Pro Tablet eine eigene WebRTC-Verbindung (P2P-Fanout) ---

function addViewer({ viewerId, name, needsOffer = true }) {
  let viewer = state.viewers.get(viewerId);
  if (!viewer) {
    viewer = {
      pc: null,
      number: state.nextLabelNumber++,
      name: name || null,
      status: 'wartet',
      stats: null,
      lastBytesSent: null,
      lastTimestamp: null,
      pendingCandidates: [],
      autoState: createAutoState(),
    };
    state.viewers.set(viewerId, viewer);
  } else if (name) {
    viewer.name = name;
  }
  // needsOffer=false heißt: die P2P-Verbindung des Tablets läuft noch (z. B. nach
  // Server-Neustart) – nicht neu verhandeln, sonst wird das Bild grundlos schwarz.
  // Das gilt aber nur, solange hier auch eine lebende Verbindung existiert: Nach einem
  // viewer:left hat der Host sie geschlossen, während das Tablet das erst nach bis zu
  // ~30 s (ICE-Consent-Timeout) bemerkt und bis dahin fälschlich needsOffer=false meldet.
  if (state.stream && (needsOffer || !viewer.pc)) {
    connectViewer({ viewerId });
  }
  renderViewers();
}

function removeViewer({ viewerId }) {
  const viewer = state.viewers.get(viewerId);
  viewer?.pc?.close();
  state.viewers.delete(viewerId);
  renderViewers();
}

async function connectViewer({ viewerId }) {
  const viewer = state.viewers.get(viewerId);
  if (!viewer || !state.stream) return;
  viewer.pc?.close();

  const pc = createPeerConnection();
  viewer.pc = pc;
  viewer.status = 'verbindet…';
  viewer.stats = null;
  viewer.lastBytesSent = null;
  viewer.pendingCandidates = [];
  // Erlernte Auto-Stufe über Reconnects behalten, nur die Messzähler zurücksetzen.
  viewer.autoState.badSamples = 0;
  viewer.autoState.cleanSinceTs = null;

  for (const track of state.stream.getTracks()) {
    pc.addTrack(track, state.stream);
  }
  applyQuality({ viewer });

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      signaling.send({ message: { type: 'signal', to: viewerId, payload: { candidate: event.candidate } } });
    }
  };
  pc.onconnectionstatechange = () => {
    if (viewer.pc !== pc) return;
    const stateMap = {
      connecting: 'verbindet…',
      connected: 'verbunden',
      disconnected: 'instabil…',
      failed: 'getrennt',
      closed: 'getrennt',
    };
    viewer.status = stateMap[pc.connectionState] ?? viewer.status;
    if (pc.connectionState === 'connected') {
      // Nach der Verhandlung erneut anwenden – vorher kann setParameters scheitern.
      applyQuality({ viewer });
    }
    if (pc.connectionState === 'failed') {
      pc.close();
      viewer.pc = null;
      viewer.stats = null;
    }
    renderViewers();
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  signaling.send({ message: { type: 'signal', to: viewerId, payload: { sdp: pc.localDescription } } });
  renderViewers();
}

function currentPreset() {
  return QUALITY_PRESETS[ui.qualitySelect.value] ?? QUALITY_PRESETS[DEFAULT_QUALITY];
}

function createAutoState() {
  return {
    step: AUTO_START_STEP,
    badSamples: 0,
    cleanSinceTs: null,
    cooldownUntilTs: 0,
    retryDelayMs: AUTO_RETRY_MS,
    lastStepUpTs: 0,
  };
}

function presetForViewer({ viewer }) {
  const selected = currentPreset();
  return selected.auto ? AUTO_LADDER[viewer.autoState.step] : selected;
}

function updateAutoStep({ viewer, stats }) {
  const auto = viewer.autoState;
  const step = AUTO_LADDER[auto.step];
  const now = performance.now();
  const lossBad = (stats.fractionLost ?? 0) > AUTO_LOSS_LIMIT;
  const cpuBad = stats.qualityLimitationReason === 'cpu';
  // 'bandwidth' meldet Chrome auch, wenn die Staukontrolle nur knapp unterm Limit
  // hängt – erst deutlich darunter ist die Stufe wirklich zu hoch. Bei statischem
  // Bildinhalt ist die Bitrate ebenfalls niedrig, der Grund dann aber 'none'.
  const bandwidthBad = stats.qualityLimitationReason === 'bandwidth'
    && stats.bitrate != null && stats.bitrate < step.maxBitrate * 0.6;

  if (lossBad || cpuBad || bandwidthBad) {
    auto.badSamples += 1;
    auto.cleanSinceTs = null;
    if (auto.badSamples >= AUTO_BAD_SAMPLES && auto.step < AUTO_LADDER.length - 1) {
      auto.step += 1;
      auto.badSamples = 0;
      // Scheitert ein Aufstieg sofort wieder, den nächsten Versuch immer weiter
      // hinausschieben – sonst pendelt die Qualität sichtbar hin und her.
      auto.retryDelayMs = now - auto.lastStepUpTs < 60_000
        ? Math.min(auto.retryDelayMs * 2, AUTO_RETRY_MAX_MS)
        : AUTO_RETRY_MS;
      auto.cooldownUntilTs = now + auto.retryDelayMs;
      applyQuality({ viewer });
    }
    return;
  }

  auto.badSamples = 0;
  auto.cleanSinceTs ??= now;
  if (auto.step > 0 && now - auto.cleanSinceTs >= AUTO_CLEAN_MS && now >= auto.cooldownUntilTs) {
    auto.step -= 1;
    auto.cleanSinceTs = now;
    auto.lastStepUpTs = now;
    applyQuality({ viewer });
  }
}

function applyQuality({ viewer }) {
  const preset = presetForViewer({ viewer });
  for (const sender of viewer.pc.getSenders()) {
    if (sender.track?.kind !== 'video') continue;
    const captureHeight = sender.track.getSettings().height;
    const scale = preset.height && captureHeight ? Math.max(1, captureHeight / preset.height) : 1;
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    Object.assign(params.encodings[0], {
      maxBitrate: preset.maxBitrate,
      maxFramerate: preset.maxFramerate,
      scaleResolutionDownBy: scale,
    });
    params.degradationPreference = 'maintain-resolution';
    sender.setParameters(params).catch(() => {});
  }
}

function applyQualityToAll() {
  for (const viewer of state.viewers.values()) {
    if (viewer.pc) applyQuality({ viewer });
  }
}

function renderQualityHint() {
  const preset = currentPreset();
  if (preset.auto) {
    ui.qualityHint.textContent =
      'Regelt pro Tablet selbst nach: bei Engpässen erst weniger fps, dann kleinere Auflösung ' +
      '(nativ/30 → nativ/15 → 1080p/30 → …) – und automatisch wieder hoch, sobald Luft ist. ' +
      'Die aktuelle Stufe steht in der Tablet-Liste.';
    return;
  }
  ui.qualityHint.textContent =
    `Max. ${formatBitrate({ bits: preset.maxBitrate })} pro Tablet – Gesamtlast im WLAN ist ` +
    '„pro Tablet × Anzahl Tablets“. Wechsel wirkt sofort, ohne die Übertragung neu zu starten.';
}

function initQualitySelect() {
  for (const [key, preset] of Object.entries(QUALITY_PRESETS)) {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = preset.label;
    ui.qualitySelect.append(option);
  }
  const saved = localStorage.getItem(QUALITY_KEY);
  ui.qualitySelect.value = QUALITY_PRESETS[saved] ? saved : DEFAULT_QUALITY;
  ui.qualitySelect.addEventListener('change', () => {
    localStorage.setItem(QUALITY_KEY, ui.qualitySelect.value);
    if (currentPreset().auto) {
      // Frisch messen statt mit veralteten „sauber seit“-Zeiten sofort hochzuspringen.
      for (const viewer of state.viewers.values()) {
        viewer.autoState.badSamples = 0;
        viewer.autoState.cleanSinceTs = null;
      }
    }
    applyQualityToAll();
    renderQualityHint();
  });
  renderQualityHint();
}

async function handleViewerSignal({ viewerId, payload }) {
  const viewer = state.viewers.get(viewerId);
  const pc = viewer?.pc;
  if (!pc) return;
  try {
    if (payload.sdp) {
      await pc.setRemoteDescription(payload.sdp);
      // Kandidaten nachschieben, die während setRemoteDescription eingetroffen sind.
      for (const candidate of viewer.pendingCandidates.splice(0)) {
        pc.addIceCandidate(candidate).catch(() => {});
      }
    } else if (payload.candidate) {
      if (pc.remoteDescription) {
        await pc.addIceCandidate(payload.candidate);
      } else {
        viewer.pendingCandidates.push(payload.candidate);
      }
    }
  } catch (err) {
    console.warn('Signal-Fehler', err);
  }
}

// --- Diagnose: Verbindungsweg, Bitrate, Verlust pro Tablet ---

setInterval(async () => {
  let anyRelay = false;
  for (const viewer of state.viewers.values()) {
    if (!viewer.pc || viewer.pc.connectionState !== 'connected') continue;
    const stats = await readConnectionStats({ pc: viewer.pc });
    if (viewer.lastBytesSent != null && stats.bytesSent != null) {
      const seconds = (stats.timestamp - viewer.lastTimestamp) / 1000;
      stats.bitrate = ((stats.bytesSent - viewer.lastBytesSent) * 8) / seconds;
    }
    viewer.lastBytesSent = stats.bytesSent;
    viewer.lastTimestamp = stats.timestamp;
    viewer.stats = stats;
    if (currentPreset().auto) updateAutoStep({ viewer, stats });
    if (stats.path === 'relay') anyRelay = true;
  }
  ui.relayAlert.classList.toggle('visible', anyRelay);
  renderViewers();
}, STATS_INTERVAL_MS);

function viewerDisplayName({ viewer }) {
  return viewer.name || `Tablet ${viewer.number}`;
}

// Namen kommen von fremden Geräten und landen in innerHTML – immer escapen.
function escapeHtml({ text }) {
  return String(text).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

function renderViewers() {
  const connected = [...state.viewers.values()].filter((viewer) => viewer.status === 'verbunden').length;
  ui.viewerCount.textContent = state.viewers.size ? `· ${connected}/${state.viewers.size} verbunden` : '';

  if (!state.viewers.size) {
    ui.viewerRows.innerHTML =
      '<tr class="empty-row"><td colspan="8">Noch keine Tablets verbunden – QR-Code scannen.</td></tr>';
    return;
  }

  ui.viewerRows.innerHTML = [...state.viewers.values()]
    .map((viewer) => {
      const stats = viewer.stats;
      const path = stats?.path ? PATH_LABELS[stats.path] : null;
      const ledClass = viewer.status === 'verbunden' ? 'ok' : viewer.status === 'wartet' ? '' : 'warn';
      const autoStep = currentPreset().auto && viewer.pc ? AUTO_LADDER[viewer.autoState.step].label : null;
      return `<tr>
        <td><span class="led ${ledClass}"></span></td>
        <td class="name">${escapeHtml({ text: viewerDisplayName({ viewer }) })}</td>
        <td>${viewer.status}${autoStep ? ` · ${autoStep}` : ''}</td>
        <td>${path ? `<span class="chip ${path.css}" title="${path.hint}">${path.text}</span>` : '–'}</td>
        <td>${formatBitrate({ bits: stats?.bitrate ?? null })}</td>
        <td>${stats?.framesPerSecond ?? '–'}</td>
        <td>${stats?.fractionLost != null ? `${(stats.fractionLost * 100).toFixed(1)} %` : '–'}</td>
        <td>${stats?.roundTripTime != null ? `${Math.round(stats.roundTripTime * 1000)} ms` : '–'}</td>
      </tr>`;
    })
    .join('');
}

initQualitySelect();
signaling.connect();
