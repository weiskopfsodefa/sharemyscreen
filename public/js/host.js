import { createMediaAuto, advanceMediaAuto } from './media-auto.js';
import { MediaClient } from './media-client.js';
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

// Bewegungsmodus hält 30 fps bis zur kleinsten Auflösung. Detailmodus
// priorisiert die Auflösung und reduziert dafür früher die Bildrate.
const STREAM_MODES = {
  motion: {
    contentHint: 'motion', degradationPreference: 'maintain-framerate', startStep: 1,
    ladder: [
      { ...QUALITY_PRESETS.source, label: 'nativ/30' },
      { ...QUALITY_PRESETS['1080p30'], label: '1080p/30' },
      { label: '720p/30', height: 720, maxFramerate: 30, maxBitrate: 2_000_000 },
      { label: '540p/30', height: 540, maxFramerate: 30, maxBitrate: 1_200_000 },
      { ...QUALITY_PRESETS['540p15'], label: '540p/15' },
    ],
  },
  detail: {
    contentHint: 'detail', degradationPreference: 'maintain-resolution', startStep: 2,
    ladder: [
      { ...QUALITY_PRESETS.source, label: 'nativ/30' },
      { label: 'nativ/15', height: null, maxFramerate: 15, maxBitrate: 4_000_000 },
      { ...QUALITY_PRESETS['1080p30'], label: '1080p/30' },
      { ...QUALITY_PRESETS['1080p15'], label: '1080p/15' },
      { label: '720p/30', height: 720, maxFramerate: 30, maxBitrate: 2_000_000 },
      { ...QUALITY_PRESETS['720p15'], label: '720p/15' },
      { ...QUALITY_PRESETS['540p15'], label: '540p/15' },
    ],
  },
};
const DEFAULT_STREAM_MODE = 'motion';
const STREAM_MODE_KEY = 'sms-stream-mode';
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
  transportMode: document.getElementById('transport-mode'),
  transportInputs: [...document.querySelectorAll('input[name="transport-mode"]')],
  transportHint: document.getElementById('transport-hint'),
  localLauncher: document.getElementById('local-launcher'),
  streamMode: document.getElementById('stream-mode'),
  modeInputs: [...document.querySelectorAll('input[name="stream-mode"]')],
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
  starting: false,
  media: null,
  mediaSession: null,
  mediaAuto: null,
  mediaStatus: null,
  mediaClient: null,
  mediaParticipants: new Set(),
  startGeneration: 0,
  streamMode: DEFAULT_STREAM_MODE,
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
      signaling.send({ message: { type: 'host:reclaim', code: saved.code, hostToken: saved.hostToken, transport: state.mediaSession ? { mode: 'livekit', session: state.mediaSession } : { mode: 'direct' } } });
    } else {
      signaling.send({ message: { type: 'host:create' } });
    }
  },
  onMessage: ({ message }) => {
    const handler = MESSAGE_HANDLERS[message.type];
    if (handler) return handler({ message });
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
  'media:stats': ({ message }) => {
    const viewer = state.viewers.get(message.viewerId);
    if (!viewer || !state.mediaClient || message.session !== state.mediaSession) return;
    viewer.stats = message.stats;
    viewer.statsReceivedAt = Date.now();
    renderViewers();
  },
  'host:created': ({ message }) => {
    state.code = message.code;
    state.hostToken = message.hostToken;
    state.media = message.media;

    localStorage.setItem(tokenKey({ code: message.code }), message.hostToken);
    localStorage.setItem(LAST_ROOM_KEY, message.code);
    // Raumcode im Pfad behalten; lokal verwendet der QR-Code die LAN-Adresse.
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
  const joinUrl = `${state.media?.publicOrigin || location.origin}/${state.code}`;
  ui.roomCode.textContent = state.code;
  ui.joinUrl.textContent = joinUrl;
  ui.copyLink.disabled = false;
  renderTransport();
  ui.qrImg.src = `/qr.svg?text=${encodeURIComponent(joinUrl)}`;
  ui.qrImg.hidden = false;
}

ui.copyLink.addEventListener('click', async () => {
  await navigator.clipboard.writeText(ui.joinUrl.textContent);
  ui.copyLink.textContent = 'Kopiert ✓';
  setTimeout(() => (ui.copyLink.textContent = 'Link kopieren'), 1500);
});

function selectedTransport() {
  return ui.transportInputs.find(input => input.checked)?.value ?? 'direct';
}

function renderTransport() {
  const media = selectedTransport() === 'livekit';
  ui.localLauncher.hidden = !media || Boolean(state.media?.available);
  ui.shareBtn.disabled = state.starting || !state.code || (media && !state.media?.available);
  ui.transportHint.textContent = media
    ? state.media?.available ? 'Ein gemeinsamer Stream über LiveKit im LAN. Qualität gilt für alle Tablets.' : 'Der Medienserver benötigt den lokalen Starter auf diesem Laptop.'
    : 'Direkt vom Laptop zu jedem Tablet.';
}
ui.transportMode.addEventListener('change', () => { renderTransport(); renderQualityHint(); });

// --- Bildschirm teilen ---

ui.shareBtn.addEventListener('click', startShare);
ui.stopBtn.addEventListener('click', stopShare);

async function startShare() {
  if (state.starting || state.stream) return;
  const useMedia = selectedTransport() === 'livekit';
  if (useMedia && !state.media?.available) return;
  const generation = ++state.startGeneration;
  state.starting = true;
  ui.shareBtn.disabled = true;
  ui.streamMode.disabled = true;
  ui.transportMode.disabled = true;
  ui.qualitySelect.disabled = useMedia;
  let stream;
  try {
    state.mediaAuto = useMedia && currentPreset().auto ? createMediaAuto(state.streamMode) : null;
    const preset = state.mediaAuto ? state.mediaAuto.ladder[state.mediaAuto.index] : currentPreset();
    stream = await navigator.mediaDevices.getDisplayMedia({ video: CAPTURE_VIDEO });
    if (generation !== state.startGeneration) { stream.getTracks().forEach(track => track.stop()); return; }
    state.stream = stream;
    const [videoTrack] = stream.getVideoTracks();
    videoTrack.contentHint = currentStreamMode().contentHint;
    videoTrack.addEventListener('ended', stopShare);
    ui.preview.srcObject = stream;
    ui.preview.classList.add('visible');
    ui.shareBtn.hidden = true;
    ui.stopBtn.hidden = false;
    ui.onairBadge.classList.add('onair');
    ui.onairText.textContent = useMedia ? 'Verbinde…' : 'ON AIR';

    if (useMedia) {
      const captureHeight = state.mediaAuto ? null : preset.height;
      await videoTrack.applyConstraints({
        ...(captureHeight ? { height: { ideal: captureHeight, max: captureHeight } } : {}),
        frameRate: { ideal: preset.maxFramerate, max: preset.maxFramerate },
      });
      if (generation !== state.startGeneration) return;
      const { transport } = await signaling.request({ type: 'host:transport', mode: 'livekit' });
      if (generation !== state.startGeneration) return;
      state.mediaSession = transport.session;
      state.mediaClient = new MediaClient({
        credentials: () => signaling.request({ type: 'media:token', session: state.mediaSession }),
        track: videoTrack,
        quality: state.mediaAuto ? preset : null,
        publishOptions: {
          screenShareEncoding: { maxBitrate: preset.maxBitrate, maxFramerate: preset.maxFramerate },
          degradationPreference: currentStreamMode().degradationPreference,
        },
        onStatus: status => {
          state.mediaStatus = status;
          if (status !== 'connected' && state.mediaAuto) state.mediaAuto.cleanSince = null;
          ui.onairText.textContent = status === 'connected' ? 'ON AIR' : 'Verbinde…';
          ui.transportHint.textContent = status === 'connected'
            ? 'LiveKit verbunden · ein gemeinsamer Stream im LAN. Geräte-Status zeigt die Verbindung zum Medienserver.'
            : 'Medienserver nicht verbunden – versuche automatisch erneut. Lokalen Starter prüfen.';
        },
        onParticipants: participants => {
          state.mediaParticipants = new Set(participants.map(p => p.identity));
          for (const [id, viewer] of state.viewers) {
            viewer.status = state.mediaParticipants.has(id) ? 'verbunden' : 'wartet';
            if (!viewer.signalingOnline && !state.mediaParticipants.has(id)) state.viewers.delete(id);
          }
          renderViewers();
        },
      });
      state.mediaClient.start();
    } else {
      for (const viewerId of state.viewers.keys()) connectViewer({ viewerId });
    }
  } catch (err) {
    if (generation === state.startGeneration) {
      stopShare();
      ui.transportHint.textContent = err.name === 'NotAllowedError'
        ? 'Bildschirmfreigabe abgebrochen oder nicht erlaubt.' : `Start fehlgeschlagen: ${err.message}`;
    }
  } finally {
    if (generation === state.startGeneration) {
      state.starting = false;
      ui.shareBtn.disabled = false;
      ui.streamMode.disabled = Boolean(state.stream);
      ui.transportMode.disabled = Boolean(state.stream);
      ui.qualitySelect.disabled = useMedia && Boolean(state.stream);
    }
  }
}

function stopShare() {
  ++state.startGeneration;
  state.starting = false;
  const hadMedia = state.mediaSession || selectedTransport() === 'livekit';
  state.mediaClient?.stop();
  state.mediaClient = null;
  state.mediaAuto = null;
  state.mediaStatus = null;
  state.mediaSession = null;
  state.mediaParticipants.clear();
  if (hadMedia) signaling.request({ type: 'host:transport', mode: 'direct' }).catch(() => {});
  ui.transportMode.disabled = false;
  ui.qualitySelect.disabled = false;
  ui.shareBtn.disabled = false;
  state.stream?.getTracks().forEach((track) => track.stop());
  state.stream = null;
  ui.streamMode.disabled = false;
  for (const viewer of state.viewers.values()) {
    clearTimeout(viewer.retryTimer);
    clearTimeout(viewer.connectTimer);
    clearTimeout(viewer.disconnectTimer);
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
  renderQualityHint();
  renderTransport();
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
  viewer.signalingOnline = true;
  if (state.mediaSession) {
    viewer.status = state.mediaParticipants.has(viewerId) ? 'verbunden' : 'wartet';
    renderViewers();
    return;
  }
  // Laufenden Aufbau nicht durch doppelte Join-/Reclaim-Nachrichten ersetzen.
  const connecting = viewer.pc && ['new', 'connecting'].includes(viewer.pc.connectionState);
  const unusable = !viewer.pc || ['failed', 'closed', 'disconnected'].includes(viewer.pc.connectionState);
  if (state.stream && !connecting && (needsOffer || unusable)) connectViewer({ viewerId });
  renderViewers();
}

function removeViewer({ viewerId }) {
  const viewer = state.viewers.get(viewerId);
  if (!viewer) return;
  viewer.signalingOnline = false;
  clearTimeout(viewer.retryTimer);
  // Ein WS-Abbruch sagt nichts über die lokale Videoverbindung aus.
  // Solange diese lebt, behalten wir sie auch bei längerem Serverausfall.
  if (!viewer.pc && !state.mediaParticipants.has(viewerId)) state.viewers.delete(viewerId);
  renderViewers();
}

function retryViewer({ viewerId, viewer, pc }) {
  if (state.viewers.get(viewerId) !== viewer || viewer.pc !== pc) return;
  clearTimeout(viewer.connectTimer);
  clearTimeout(viewer.disconnectTimer);
  viewer.pc = null;
  pc.close();
  viewer.stats = null;
  viewer.status = 'getrennt';
  if (!viewer.signalingOnline) {
    state.viewers.delete(viewerId);
  } else if (state.stream) {
    clearTimeout(viewer.retryTimer);
    viewer.retryTimer = setTimeout(() => {
      if (state.viewers.get(viewerId) === viewer && !viewer.pc && viewer.signalingOnline) {
        connectViewer({ viewerId });
      }
    }, 3000);
  }
  renderViewers();
}

async function connectViewer({ viewerId }) {
  const viewer = state.viewers.get(viewerId);
  if (!viewer || !state.stream || !viewer.signalingOnline || selectedTransport() === 'livekit') return;
  clearTimeout(viewer.retryTimer);
  clearTimeout(viewer.connectTimer);
  clearTimeout(viewer.disconnectTimer);
  viewer.pc?.close();

  const pc = createPeerConnection();
  const negotiationId = crypto.randomUUID();
  viewer.negotiationId = negotiationId;
  viewer.pc = pc;
  viewer.status = 'verbindet…';
  viewer.stats = null;
  viewer.lastBytesSent = null;
  viewer.pendingCandidates = [];
  viewer.autoState.badSamples = 0;
  viewer.autoState.cleanSinceTs = null;
  const isCurrent = () => state.viewers.get(viewerId) === viewer && viewer.pc === pc;
  const retry = () => retryViewer({ viewerId, viewer, pc });
  viewer.connectTimer = setTimeout(retry, 25_000);
  const outgoingCandidates = [];
  let offerSent = false;
  const sendCandidate = (candidate) => signaling.send({
    message: { type: 'signal', to: viewerId, payload: { candidate, negotiationId } },
  });

  pc.onicecandidate = (event) => {
    if (!isCurrent() || !event.candidate) return;
    if (offerSent) sendCandidate(event.candidate);
    else outgoingCandidates.push(event.candidate);
  };
  pc.onconnectionstatechange = () => {
    if (!isCurrent()) return;
    const stateMap = {
      connecting: 'verbindet…', connected: 'verbunden', disconnected: 'instabil…',
      failed: 'getrennt', closed: 'getrennt',
    };
    viewer.status = stateMap[pc.connectionState] ?? viewer.status;
    if (pc.connectionState === 'connected') {
      clearTimeout(viewer.connectTimer);
      clearTimeout(viewer.disconnectTimer);
      applyQuality({ viewer });
    } else if (pc.connectionState === 'failed') {
      retry();
    } else if (pc.connectionState === 'disconnected') {
      clearTimeout(viewer.disconnectTimer);
      viewer.disconnectTimer = setTimeout(() => {
        if (pc.connectionState === 'disconnected') retry();
      }, 8000);
    }
    renderViewers();
  };

  try {
    for (const track of state.stream.getTracks()) pc.addTrack(track, state.stream);
    applyQuality({ viewer });
    const offer = await pc.createOffer();
    if (!isCurrent()) return;
    await pc.setLocalDescription(offer);
    if (!isCurrent()) return;
    if (!signaling.send({ message: { type: 'signal', to: viewerId, payload: { sdp: pc.localDescription, negotiationId } } })) {
      retry();
      return;
    }
    offerSent = true;
    outgoingCandidates.forEach(sendCandidate);
    renderViewers();
  } catch (err) {
    console.warn('Verbindungsaufbau fehlgeschlagen', err);
    retry();
  }
}

function currentStreamMode() {
  return STREAM_MODES[state.streamMode];
}

function initStreamMode() {
  const saved = localStorage.getItem(STREAM_MODE_KEY);
  state.streamMode = Object.hasOwn(STREAM_MODES, saved) ? saved : DEFAULT_STREAM_MODE;
  for (const input of ui.modeInputs) {
    input.checked = input.value === state.streamMode;
    input.addEventListener('change', () => {
      if (!input.checked || state.stream || state.starting) return;
      state.streamMode = input.value;
      localStorage.setItem(STREAM_MODE_KEY, state.streamMode);
      for (const viewer of state.viewers.values()) viewer.autoState = createAutoState();
      renderQualityHint();
      renderViewers();
    });
  }
}

function currentPreset() {
  return QUALITY_PRESETS[ui.qualitySelect.value] ?? QUALITY_PRESETS[DEFAULT_QUALITY];
}

function createAutoState() {
  return {
    step: currentStreamMode().startStep,
    badSamples: 0,
    cleanSinceTs: null,
    cooldownUntilTs: 0,
    retryDelayMs: AUTO_RETRY_MS,
    lastStepUpTs: 0,
  };
}

function presetForViewer({ viewer }) {
  const selected = currentPreset();
  return selected.auto ? currentStreamMode().ladder[viewer.autoState.step] : selected;
}

function updateAutoStep({ viewer, stats }) {
  const auto = viewer.autoState;
  const step = currentStreamMode().ladder[auto.step];
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
    if (auto.badSamples >= AUTO_BAD_SAMPLES && auto.step < currentStreamMode().ladder.length - 1) {
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
  for (const sender of viewer.pc?.getSenders() ?? []) {
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
    params.degradationPreference = currentStreamMode().degradationPreference;
    sender.setParameters(params).catch((err) => console.warn('Qualitätseinstellungen nicht angewendet', err));
  }
}

function applyQualityToAll() {
  for (const viewer of state.viewers.values()) {
    if (viewer.pc) applyQuality({ viewer });
  }
}

function renderQualityHint() {
  const preset = currentPreset();
  if (selectedTransport() === 'livekit') {
    ui.qualityHint.textContent = currentPreset().auto
      ? `Automatisch · gemeinsame Zielstufe: ${state.mediaAuto ? state.mediaAuto.ladder[state.mediaAuto.index].label : '720p / 30 FPS'}. Nach 30 Sekunden stabiler Übertragung schrittweise bis zur nativen Quellauflösung; bei Engpässen zurück. Ein schwaches Tablet kann die Qualität für alle senken.`
      : 'Gemeinsame Qualität für alle Tablets. Zum Ändern die Übertragung beenden.';
    return;
  }
  if (preset.auto) {
    ui.qualityHint.textContent = state.streamMode === 'motion'
      ? 'Automatisch pro Tablet: möglichst 30 fps für Videos. Bei Engpässen zuerst kleinere Auflösung, erst auf der kleinsten Stufe 15 fps.'
      : 'Automatisch pro Tablet: scharfe Details für Text und Präsentationen. Bei Engpässen zuerst weniger fps, danach kleinere Auflösung.';
    return;
  }
  ui.qualityHint.textContent =
    `Max. ${formatBitrate({ bits: preset.maxBitrate })} pro Tablet – Gesamtlast im WLAN ist ` +
    '„pro Tablet × Anzahl Tablets“. Feste fps- und Auflösungsgrenzen gelten auch für die gewählte Priorität. Wechsel wirkt sofort.';
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
  if (!pc || !payload || payload.negotiationId !== viewer.negotiationId) return;
  try {
    if (payload.sdp?.type === 'answer') {
      await pc.setRemoteDescription(payload.sdp);
      if (viewer.pc !== pc) return;
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
    retryViewer({ viewerId, viewer, pc });
  }
}

// --- Diagnose: Verbindungsweg, Bitrate, Verlust pro Tablet ---

let mediaAutoBusy = false;
async function updateMediaAuto() {
  const client = state.mediaClient;
  const auto = state.mediaAuto;
  if (!client || !auto || mediaAutoBusy || state.mediaStatus !== 'connected') return;
  mediaAutoBusy = true;
  try {
    const upload = await client.readUploadStats();
    if (client !== state.mediaClient || auto !== state.mediaAuto || state.mediaStatus !== 'connected') return;
    const receivers = [...state.mediaParticipants].map(id => {
      const viewer = state.viewers.get(id);
      return { id, stats: viewer?.stats, at: viewer?.statsReceivedAt || 0 };
    });
    const next = { ...auto };
    const changed = advanceMediaAuto(next, { now: Date.now(), upload, receivers });
    if (changed && !await client.setQuality(next.ladder[next.index])) return;
    if (client !== state.mediaClient || auto !== state.mediaAuto) return;
    state.mediaAuto = next;
    if (changed) renderQualityHint();
  } catch {
    // Keep the last applied target; never display a level the encoder rejected.
    if (auto === state.mediaAuto) auto.cleanSince = null;
  } finally { mediaAutoBusy = false; }
}

setInterval(async () => {
  await updateMediaAuto();
  let anyRelay = false;
  for (const viewer of state.viewers.values()) {
    if (!viewer.pc || viewer.pc.connectionState !== 'connected') continue;
    const pc = viewer.pc;
    let stats;
    try { stats = await readConnectionStats({ pc }); } catch { continue; }
    if (viewer.pc !== pc) continue;
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
      '<tr class="empty-row"><td colspan="9">Noch keine Tablets verbunden – QR-Code scannen.</td></tr>';
    return;
  }

  ui.viewerRows.innerHTML = [...state.viewers.values()]
    .map((viewer) => {
      const media = Boolean(state.mediaClient);
      const stats = media && (viewer.status !== 'verbunden' || Date.now() - (viewer.statsReceivedAt || 0) > 10_000)
        ? null : viewer.stats;
      const path = stats?.path ? PATH_LABELS[stats.path] : null;
      const ledClass = viewer.status === 'verbunden' ? 'ok' : viewer.status === 'wartet' ? '' : 'warn';
      const autoStep = currentPreset().auto && viewer.pc ? currentStreamMode().ladder[viewer.autoState.step].label : null;
      return `<tr>
        <td><span class="led ${ledClass}"></span></td>
        <td class="name" title="${escapeHtml({ text: viewerDisplayName({ viewer }) })}">${escapeHtml({ text: viewerDisplayName({ viewer }) })}</td>
        <td title="${escapeHtml({ text: `${viewer.status}${autoStep ? ` · ${autoStep}` : ''}` })}">${viewer.status}${autoStep ? ` · ${autoStep}` : ''}</td>
        <td>${media ? '<span class="chip ok">MEDIENSERVER</span>' : path ? `<span class="chip ${path.css}" title="${path.hint}">${path.text}</span>` : '–'}</td>
        <td>${formatBitrate({ bits: stats?.bitrate ?? null })}</td>
        <td>${stats?.framesPerSecond != null ? Math.round(stats.framesPerSecond) : '–'}</td>
        <td>${stats?.frameWidth && stats?.frameHeight ? `${stats.frameWidth} × ${stats.frameHeight}` : '–'}</td>
        <td>${stats?.fractionLost != null ? `${(stats.fractionLost * 100).toFixed(1)} %` : '–'}</td>
        <td>${stats?.roundTripTime != null ? `${Math.round(stats.roundTripTime * 1000)} ms` : '–'}</td>
      </tr>`;
    })
    .join('');
}

initStreamMode();
initQualitySelect();
signaling.connect();
