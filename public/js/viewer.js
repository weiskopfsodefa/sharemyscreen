import { SignalingClient } from './signaling.js';
import { createPeerConnection, readConnectionStats, PATH_LABELS } from './webrtc.js';

const REJOIN_DELAY_MS = 2000;
const DISCONNECT_GRACE_MS = 4000;
const CONTROLS_FADE_MS = 3500;
const STATS_INTERVAL_MS = 3000;

const ui = {
  video: document.getElementById('stream'),
  overlay: document.getElementById('overlay'),
  statusText: document.getElementById('status-text'),
  substatusText: document.getElementById('substatus-text'),
  tapToStart: document.getElementById('tap-to-start'),
  renameBtn: document.getElementById('rename-btn'),
  zoomChip: document.getElementById('zoom-chip'),
  pathChip: document.getElementById('path-chip'),
  controls: document.getElementById('controls'),
  muteBtn: document.getElementById('mute-btn'),
  fullscreenBtn: document.getElementById('fullscreen-btn'),
};

const roomCode = location.pathname.split('/').pop().toUpperCase();
const VIEWER_ID_KEY = `sms-viewer-${roomCode}`;
const DEVICE_NAME_KEY = 'sms-device-name';

const state = {
  viewerId: sessionStorage.getItem(VIEWER_ID_KEY) || null,
  deviceModel: null,
  pc: null,
  // Kandidaten, die eintreffen, bevor setRemoteDescription fertig ist – sonst gehen
  // ausgerechnet die zuerst gesendeten lokalen LAN-Kandidaten verloren.
  pendingCandidates: [],
  wakeLock: null,
  rejoinTimer: null,
  fadeTimer: null,
  stuckTimer: null,
};

function setStatus({ text, sub = '' }) {
  ui.overlay.classList.remove('hidden');
  ui.statusText.textContent = text;
  ui.substatusText.textContent = sub;
}

// --- Signaling ---

const signaling = new SignalingClient({
  onOpen: () => joinRoom(),
  onMessage: ({ message }) => {
    const handler = MESSAGE_HANDLERS[message.type];
    if (handler) handler({ message });
  },
  onStatusChange: ({ status }) => {
    if (status === 'offline' && !state.pc) {
      setStatus({ text: 'Server getrennt', sub: 'Verbinde neu…' });
    }
  },
});

// Der vom Nutzer vergebene Gerätename ist für Webseiten nicht auslesbar –
// das Gerätemodell (z. B. "SM-T510") aus den Client Hints ist das Nächstbeste.
async function detectDeviceModel() {
  try {
    const hints = await navigator.userAgentData?.getHighEntropyValues?.(['model']);
    if (hints?.model) return hints.model;
  } catch {
    // Client Hints nicht verfügbar – unten Fallback über den User-Agent.
  }
  const match = navigator.userAgent.match(/\(Linux;[^)]*Android[^;)]*;\s*([^);]+)/);
  return match ? match[1].trim() : null;
}

function deviceName() {
  return localStorage.getItem(DEVICE_NAME_KEY) || state.deviceModel || null;
}

function joinRoom() {
  signaling.send({
    message: { type: 'viewer:join', code: roomCode, viewerId: state.viewerId, name: deviceName() },
  });
}

ui.renameBtn.addEventListener('click', () => {
  const input = prompt('Name dieses Tablets (z. B. „Theke“):', deviceName() ?? '');
  if (input === null) return;
  const name = input.trim().slice(0, 40);
  if (name) {
    localStorage.setItem(DEVICE_NAME_KEY, name);
  } else {
    localStorage.removeItem(DEVICE_NAME_KEY);
  }
  signaling.send({ message: { type: 'viewer:rename', name: deviceName() } });
});

const MESSAGE_HANDLERS = {
  'viewer:joined': ({ message }) => {
    state.viewerId = message.viewerId;
    sessionStorage.setItem(VIEWER_ID_KEY, message.viewerId);
    if (!state.pc) {
      setStatus({
        text: message.hostOnline === false ? 'Host ist offline' : 'Warten auf Übertragung…',
        sub: `Raum ${roomCode}`,
      });
    }
  },
  'host:online': () => {
    if (!state.pc) setStatus({ text: 'Warten auf Übertragung…', sub: `Raum ${roomCode}` });
  },
  'host:offline': () => {
    if (!state.pc) setStatus({ text: 'Host ist offline', sub: 'Warten auf erneute Verbindung…' });
  },
  'room:closed': () => {
    teardownPeer();
    setStatus({ text: 'Raum wurde geschlossen', sub: 'Bitte neuen QR-Code scannen.' });
  },
  error: ({ message }) => {
    if (message.code === 'room-not-found') {
      setStatus({ text: 'Raum nicht gefunden', sub: `Code „${roomCode}“ prüfen oder QR-Code neu scannen.` });
    } else if (message.code === 'room-full') {
      setStatus({ text: 'Raum ist voll', sub: 'Maximale Anzahl Tablets erreicht.' });
    }
  },
  signal: async ({ message }) => {
    const { payload } = message;
    if (payload.sdp) {
      await acceptOffer({ sdp: payload.sdp });
    } else if (payload.candidate) {
      if (state.pc?.remoteDescription) {
        state.pc.addIceCandidate(payload.candidate).catch(() => {});
      } else {
        state.pendingCandidates.push(payload.candidate);
      }
    }
  },
};

// --- WebRTC-Empfang ---

async function acceptOffer({ sdp }) {
  teardownPeer();
  const pc = createPeerConnection();
  state.pc = pc;
  state.pendingCandidates = [];
  setStatus({ text: 'Verbinde mit Host…', sub: `Raum ${roomCode}` });

  clearTimeout(state.stuckTimer);
  state.stuckTimer = setTimeout(() => {
    if (state.pc === pc && pc.connectionState !== 'connected') {
      setStatus({
        text: 'Verbindung kommt nicht zustande',
        sub: 'Häufige Ursachen: VPN am Host-Laptop aktiv, oder das WLAN blockiert Geräte-zu-Geräte-Verkehr (Client-/AP-Isolation am Router).',
      });
    }
  }, 10_000);

  pc.ontrack = (event) => {
    const [stream] = event.streams;
    if (ui.video.srcObject !== stream) {
      ui.video.srcObject = stream;
      ui.muteBtn.hidden = stream.getAudioTracks().length === 0;
      playVideo();
    }
  };
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      signaling.send({ message: { type: 'signal', payload: { candidate: event.candidate } } });
    }
  };
  pc.onconnectionstatechange = () => {
    if (state.pc !== pc) return;
    if (pc.connectionState === 'connected') {
      clearTimeout(state.stuckTimer);
      ui.overlay.classList.add('hidden');
      requestWakeLock();
      showControls();
    } else if (pc.connectionState === 'failed') {
      handleConnectionLost();
    } else if (pc.connectionState === 'disconnected') {
      setTimeout(() => {
        if (state.pc === pc && pc.connectionState === 'disconnected') handleConnectionLost();
      }, DISCONNECT_GRACE_MS);
    }
  };

  await pc.setRemoteDescription(sdp);
  for (const candidate of state.pendingCandidates.splice(0)) {
    pc.addIceCandidate(candidate).catch(() => {});
  }
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  signaling.send({ message: { type: 'signal', payload: { sdp: pc.localDescription } } });
}

function teardownPeer() {
  state.pc?.close();
  state.pc = null;
}

function handleConnectionLost() {
  teardownPeer();
  setStatus({ text: 'Verbindung verloren', sub: 'Verbinde automatisch neu…' });
  if (state.rejoinTimer) return;
  state.rejoinTimer = setTimeout(() => {
    state.rejoinTimer = null;
    joinRoom();
  }, REJOIN_DELAY_MS);
}

function playVideo() {
  ui.video.play().then(
    () => ui.tapToStart.classList.remove('visible'),
    () => ui.tapToStart.classList.add('visible'),
  );
}

ui.tapToStart.addEventListener('click', () => {
  ui.tapToStart.classList.remove('visible');
  playVideo();
});

// --- Ton, Vollbild, Wake Lock ---

ui.muteBtn.addEventListener('click', () => {
  ui.video.muted = !ui.video.muted;
  ui.muteBtn.textContent = ui.video.muted ? '🔇' : '🔊';
});

ui.fullscreenBtn.addEventListener('click', async () => {
  if (document.fullscreenElement) {
    await document.exitFullscreen();
    return;
  }
  await document.documentElement.requestFullscreen().catch(() => {});
  // Querformat passt fast immer besser zum geteilten Bildschirm.
  screen.orientation?.lock?.('landscape').catch(() => {});
});

async function requestWakeLock() {
  try {
    state.wakeLock = await navigator.wakeLock.request('screen');
  } catch {
    // Wake Lock nicht verfügbar – Tablet-Einstellung "Display an" nutzen.
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (state.pc) requestWakeLock();
    playVideo();
  }
});

// --- Zoom & Schwenken auf dem Stream (Pinch, Ziehen, Doppeltipp) ---
// Browser-Pinch ist per Viewport-Meta deaktiviert, damit nur das Video zoomt,
// nicht die Bedienelemente – deshalb hier eigene Gesten über Pointer Events.

const MIN_ZOOM = 1;
const MAX_ZOOM = 6;
const DOUBLE_TAP_ZOOM = 2.5;

const zoom = { scale: 1, tx: 0, ty: 0, pointers: new Map() };

function clampPan() {
  const maxX = ((zoom.scale - 1) * window.innerWidth) / 2;
  const maxY = ((zoom.scale - 1) * window.innerHeight) / 2;
  zoom.tx = Math.min(maxX, Math.max(-maxX, zoom.tx));
  zoom.ty = Math.min(maxY, Math.max(-maxY, zoom.ty));
}

function applyZoom() {
  clampPan();
  ui.video.style.transform =
    zoom.scale === 1 ? '' : `translate(${zoom.tx}px, ${zoom.ty}px) scale(${zoom.scale})`;
  ui.zoomChip.hidden = zoom.scale === 1;
  ui.zoomChip.textContent = `${zoom.scale.toFixed(1)}× · zurücksetzen`;
}

// Zoomt so, dass der Bildpunkt unter (x, y) an Ort und Stelle bleibt.
function zoomAround({ scale, x, y }) {
  const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
  const dx = x - window.innerWidth / 2;
  const dy = y - window.innerHeight / 2;
  zoom.tx = dx - (next / zoom.scale) * (dx - zoom.tx);
  zoom.ty = dy - (next / zoom.scale) * (dy - zoom.ty);
  zoom.scale = next;
  applyZoom();
}

function resetZoom() {
  zoom.scale = 1;
  zoom.tx = 0;
  zoom.ty = 0;
  applyZoom();
}

function pinchInfo() {
  const [a, b] = [...zoom.pointers.values()];
  return { dist: Math.hypot(a.x - b.x, a.y - b.y), midX: (a.x + b.x) / 2, midY: (a.y + b.y) / 2 };
}

ui.video.addEventListener('pointerdown', (event) => {
  ui.video.setPointerCapture(event.pointerId);
  zoom.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
});

ui.video.addEventListener('pointermove', (event) => {
  const prev = zoom.pointers.get(event.pointerId);
  if (!prev) return;
  const current = { x: event.clientX, y: event.clientY };
  if (zoom.pointers.size === 2) {
    const before = pinchInfo();
    zoom.pointers.set(event.pointerId, current);
    const after = pinchInfo();
    zoom.tx += after.midX - before.midX;
    zoom.ty += after.midY - before.midY;
    zoomAround({ scale: zoom.scale * (after.dist / before.dist), x: after.midX, y: after.midY });
  } else if (zoom.scale > 1) {
    zoom.pointers.set(event.pointerId, current);
    zoom.tx += current.x - prev.x;
    zoom.ty += current.y - prev.y;
    applyZoom();
  }
});

for (const type of ['pointerup', 'pointercancel']) {
  ui.video.addEventListener(type, (event) => zoom.pointers.delete(event.pointerId));
}

ui.video.addEventListener('dblclick', (event) => {
  if (zoom.scale > 1) {
    resetZoom();
  } else {
    zoomAround({ scale: DOUBLE_TAP_ZOOM, x: event.clientX, y: event.clientY });
  }
});

// Trackpad-Pinch am Desktop kommt als Strg+Scroll an.
ui.video.addEventListener('wheel', (event) => {
  if (!event.ctrlKey) return;
  event.preventDefault();
  zoomAround({ scale: zoom.scale * (1 - event.deltaY * 0.01), x: event.clientX, y: event.clientY });
}, { passive: false });

ui.zoomChip.addEventListener('click', resetZoom);

// --- Bedienelemente ein-/ausblenden ---

function showControls() {
  ui.controls.classList.remove('faded');
  ui.pathChip.classList.remove('faded');
  clearTimeout(state.fadeTimer);
  state.fadeTimer = setTimeout(() => {
    ui.controls.classList.add('faded');
    ui.pathChip.classList.add('faded');
  }, CONTROLS_FADE_MS);
}

document.addEventListener('pointerdown', showControls);

// --- Verbindungsweg-Anzeige ---

setInterval(async () => {
  if (!state.pc || state.pc.connectionState !== 'connected') {
    ui.pathChip.textContent = '';
    return;
  }
  const stats = await readConnectionStats({ pc: state.pc });
  const path = stats.path ? PATH_LABELS[stats.path] : null;
  if (path) {
    ui.pathChip.textContent = path.text;
    ui.pathChip.className = `chip viewer-chip ${path.css} ${ui.controls.classList.contains('faded') ? 'faded' : ''}`;
  }
}, STATS_INTERVAL_MS);

if (!/^[A-Z0-9]{4,8}$/.test(roomCode)) {
  setStatus({ text: 'Ungültiger Link', sub: 'Bitte QR-Code neu scannen.' });
} else {
  setStatus({ text: 'Verbinde…', sub: `Raum ${roomCode}` });
  detectDeviceModel().then((model) => {
    state.deviceModel = model;
    signaling.connect();
  });
}
