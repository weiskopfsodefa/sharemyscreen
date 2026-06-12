import { SignalingClient } from './signaling.js';
import { createPeerConnection, readConnectionStats, formatBitrate, PATH_LABELS } from './webrtc.js';

// Es wird immer in nativer Auflösung gecaptured; das Preset steuert pro Verbindung
// die Encoder-Skalierung und Bitrate – Wechsel wirkt dadurch live, ohne Neustart.
const QUALITY_PRESETS = {
  '540p15': { label: '540p · 15 fps – sparsam', height: 540, maxFramerate: 15, maxBitrate: 700_000 },
  '720p15': { label: '720p · 15 fps – Standard', height: 720, maxFramerate: 15, maxBitrate: 1_200_000 },
  '1080p15': { label: '1080p · 15 fps', height: 1080, maxFramerate: 15, maxBitrate: 2_500_000 },
  '1080p30': { label: '1080p · 30 fps', height: 1080, maxFramerate: 30, maxBitrate: 4_000_000 },
  source: { label: 'Quelle (nativ) · 30 fps', height: null, maxFramerate: 30, maxBitrate: 6_000_000 },
};
const DEFAULT_QUALITY = '720p15';
const QUALITY_KEY = 'sms-quality';
const CAPTURE_VIDEO = { frameRate: { ideal: 30, max: 30 } };
// Sprachverarbeitung aus – die ist für Mikrofone gedacht und verstümmelt Systemaudio/Musik.
const CAPTURE_AUDIO = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
const STATS_INTERVAL_MS = 2000;
const SESSION_KEY = 'sms-host-room';

const ui = {
  roomCode: document.getElementById('room-code'),
  qrImg: document.getElementById('qr-img'),
  joinUrl: document.getElementById('join-url'),
  copyLink: document.getElementById('copy-link'),
  shareBtn: document.getElementById('share-btn'),
  stopBtn: document.getElementById('stop-btn'),
  audioCheckbox: document.getElementById('audio-checkbox'),
  qualitySelect: document.getElementById('quality-select'),
  qualityHint: document.getElementById('quality-hint'),
  audioAlert: document.getElementById('audio-alert'),
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
    if (state.hostToken) {
      signaling.send({ message: { type: 'host:reclaim', code: state.code, hostToken: state.hostToken } });
    } else {
      const saved = readSavedRoom();
      if (saved) {
        state.code = saved.code;
        state.hostToken = saved.hostToken;
        signaling.send({ message: { type: 'host:reclaim', ...saved } });
      } else {
        signaling.send({ message: { type: 'host:create' } });
      }
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
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEY));
  } catch {
    return null;
  }
}

const MESSAGE_HANDLERS = {
  'host:created': ({ message }) => {
    state.code = message.code;
    state.hostToken = message.hostToken;
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ code: message.code, hostToken: message.hostToken }));
    renderRoom();
  },
  'viewer:joined': ({ message }) => addViewer({ viewerId: message.viewerId, name: message.name }),
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
      // Gespeicherter Raum ist abgelaufen – neuen anlegen.
      sessionStorage.removeItem(SESSION_KEY);
      state.code = null;
      state.hostToken = null;
      signaling.send({ message: { type: 'host:create' } });
    }
  },
};

function renderRoom() {
  const joinUrl = `${location.origin}/v/${state.code}`;
  ui.roomCode.textContent = state.code;
  ui.joinUrl.textContent = joinUrl;
  ui.copyLink.disabled = false;
  ui.shareBtn.disabled = false;
  ui.qrImg.src = `/qr.svg?text=${encodeURIComponent(joinUrl)}`;
  ui.qrImg.hidden = false;
}

ui.copyLink.addEventListener('click', async () => {
  await navigator.clipboard.writeText(`${location.origin}/v/${state.code}`);
  ui.copyLink.textContent = 'Kopiert ✓';
  setTimeout(() => (ui.copyLink.textContent = 'Link kopieren'), 1500);
});

// --- Bildschirm teilen ---

ui.shareBtn.addEventListener('click', startShare);
ui.stopBtn.addEventListener('click', stopShare);

async function startShare() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: CAPTURE_VIDEO,
      audio: ui.audioCheckbox.checked ? CAPTURE_AUDIO : false,
      systemAudio: 'include',
    });
  } catch {
    return; // Nutzer hat den Dialog abgebrochen.
  }
  state.stream = stream;
  ui.audioAlert.classList.toggle(
    'visible',
    ui.audioCheckbox.checked && stream.getAudioTracks().length === 0,
  );
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
  ui.audioAlert.classList.remove('visible');
  ui.shareBtn.hidden = false;
  ui.stopBtn.hidden = true;
  ui.onairBadge.classList.remove('onair');
  ui.onairText.textContent = 'Bereit';
  renderViewers();
}

// --- Pro Tablet eine eigene WebRTC-Verbindung (P2P-Fanout) ---

function addViewer({ viewerId, name }) {
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
    };
    state.viewers.set(viewerId, viewer);
  } else if (name) {
    viewer.name = name;
  }
  if (state.stream) {
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

  for (const track of state.stream.getTracks()) {
    pc.addTrack(track, state.stream);
  }
  applyQuality({ pc });

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
      applyQuality({ pc });
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

function applyQuality({ pc }) {
  const preset = currentPreset();
  for (const sender of pc.getSenders()) {
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
    if (viewer.pc) applyQuality({ pc: viewer.pc });
  }
}

function renderQualityHint() {
  const preset = currentPreset();
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
      return `<tr>
        <td><span class="led ${ledClass}"></span></td>
        <td class="name">${escapeHtml({ text: viewerDisplayName({ viewer }) })}</td>
        <td>${viewer.status}</td>
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
