import { MediaClient } from './media-client.js';
import { SignalingClient } from './signaling.js';
import { createPeerConnection, readConnectionStats, PATH_LABELS } from './webrtc.js';

const REJOIN_DELAY_MS = 2000;
const JOIN_RETRY_MS = 10_000;
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
  fullscreenBtn: document.getElementById('fullscreen-btn'),
};

const roomCode = location.pathname.split('/').pop().toUpperCase();
const VIEWER_ID_KEY = `sms-viewer-${roomCode}`;
const DEVICE_NAME_KEY = 'sms-device-name';

const state = {
  viewerId: sessionStorage.getItem(VIEWER_ID_KEY) || null,
  deviceModel: null,
  pc: null,
  transport: { mode: 'direct' },
  mediaClient: null,
  mediaPlaying: false,
  // Kandidaten, die eintreffen, bevor setRemoteDescription fertig ist – sonst gehen
  // ausgerechnet die zuerst gesendeten lokalen LAN-Kandidaten verloren.
  pendingCandidates: [],
  negotiationId: null,
  wakeLock: null,
  rejoinTimer: null,
  joinRetryTimer: null,
  fadeTimer: null,
  stuckTimer: null,
  disconnectTimer: null,
};

// Raum-Codes sind dauerhaft: Kommt der Host (oder der Server) zurück, existiert
// derselbe Code wieder – deshalb nie aufgeben, sondern periodisch neu versuchen.
function scheduleJoinRetry() {
  clearTimeout(state.joinRetryTimer);
  state.joinRetryTimer = setTimeout(() => joinRoom(), JOIN_RETRY_MS);
}

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
    if (handler) return handler({ message });
  },
  onStatusChange: ({ status }) => {
    if (status === 'offline' && !state.pc && !state.mediaPlaying) {
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
  clearTimeout(state.rejoinTimer);
  state.rejoinTimer = null;
  // Auch während eines Aufbaus nach WS-Reconnect beim Server registrieren,
  // aber kein zweites Angebot anfordern. Der Aufbau hat einen eigenen Timeout.
  scheduleJoinRetry();
  signaling.send({
    message: {
      type: 'viewer:join',
      code: roomCode,
      viewerId: state.viewerId,
      name: deviceName(),
      // Läuft die P2P-Verbindung noch (z. B. WS-Reconnect nach Server-Neustart),
      // braucht der Host kein neues Angebot zu schicken – das Bild bliebe sonst kurz schwarz.
      needsOffer: state.transport.mode === 'direct' && (!state.pc || !['new', 'connecting', 'connected'].includes(state.pc.connectionState)),
    },
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

function setTransport(transport = { mode: 'direct' }) {
  if (transport.mode === state.transport.mode && transport.session === state.transport.session) return;
  state.mediaClient?.stop();
  state.mediaClient = null;
  state.mediaPlaying = false;
  teardownPeer();
  clearTimeout(state.rejoinTimer);
  state.rejoinTimer = null;
  state.transport = transport;
  if (transport.mode === 'livekit') {
    clearTimeout(state.joinRetryTimer);
    setStatus({ text: 'Verbinde mit Medienserver…', sub: `Raum ${roomCode}` });
    state.mediaClient = new MediaClient({
      credentials: () => signaling.request({ type: 'media:token', session: transport.session }),
      video: ui.video,
      onStatus: status => {
        if (status !== 'connected' && !state.mediaPlaying) {
          setStatus({ text: 'Verbinde mit Medienserver…', sub: 'Versuche automatisch erneut…' });
        } else if (status === 'connected' && !state.mediaPlaying) {
          setStatus({ text: 'Warten auf Übertragung…', sub: `Raum ${roomCode}` });
        }
      },
      onVideo: playing => {
        state.mediaPlaying = playing;
        if (playing) {
          ui.overlay.classList.add('hidden');
          ui.pathChip.textContent = 'MEDIENSERVER · LAN';
          playVideo(); requestWakeLock(); showControls();
        } else setStatus({ text: 'Warten auf Übertragung…', sub: `Raum ${roomCode}` });
      },
    });
    state.mediaClient.start();
  } else {
    ui.video.srcObject = null;
    ui.pathChip.textContent = '';
    setStatus({ text: 'Warten auf Übertragung…', sub: `Raum ${roomCode}` });
    joinRoom();
  }
}

const MESSAGE_HANDLERS = {
  'room:transport': ({ message }) => setTransport(message.transport),
  'viewer:joined': ({ message }) => {
    state.viewerId = message.viewerId;
    sessionStorage.setItem(VIEWER_ID_KEY, message.viewerId);
    setTransport(message.transport);
    if (state.transport.mode === 'livekit') {
      clearTimeout(state.joinRetryTimer);
      return;
    }
    // Läuft das Video bereits (Rejoin nach Server-Neustart bei intakter P2P-Verbindung),
    // wird ohne Neuverhandlung kein 'connected'-Event mehr feuern – den Overlay, den
    // ein zwischenzeitliches „Raum nicht aktiv“ gezeigt hat, hier explizit verstecken.
    if (state.pc?.connectionState === 'connected') {
      clearTimeout(state.joinRetryTimer);
      ui.overlay.classList.add('hidden');
      return;
    }
    if (!state.pc) {
      setStatus({
        text: message.hostOnline === false ? 'Host ist offline' : 'Warten auf Übertragung…',
        sub: `Raum ${roomCode}`,
      });
    }
  },
  'host:online': () => {
    if (state.transport.mode === 'livekit') { joinRoom(); return; }
    if (state.pc?.connectionState === 'connected') return;
    setStatus({ text: 'Warten auf Übertragung…', sub: `Raum ${roomCode}` });
    // Erneut beitreten: Der zurückgekehrte Host erfährt so per needsOffer, dass dieses
    // Tablet (im Gegensatz zu weiterlaufenden) ein neues Angebot braucht.
    joinRoom();
  },
  'host:offline': () => {
    if (!state.pc && !state.mediaPlaying) setStatus({ text: 'Host ist offline', sub: 'Warten auf erneute Verbindung…' });
  },
  'room:closed': () => {
    if (state.pc?.connectionState !== 'connected' && !state.mediaPlaying) {
      teardownPeer();
      setStatus({ text: 'Raum gerade nicht aktiv', sub: 'Verbinde automatisch neu, sobald der Host zurück ist…' });
    }
    scheduleJoinRetry();
  },
  error: ({ message }) => {
    if (message.code === 'room-not-found') {
      // Passiert auch bei laufendem Video (Server neu gestartet, Host noch nicht
      // zurück) – dann kein Status-Overlay über den funktionierenden Stream legen.
      if (state.pc?.connectionState !== 'connected' && !state.mediaPlaying) {
        setStatus({ text: 'Raum nicht aktiv', sub: `Warte auf Raum „${roomCode}“ – verbinde automatisch…` });
      }
      scheduleJoinRetry();
    } else if (message.code === 'room-full') {
      setStatus({ text: 'Raum ist voll', sub: 'Warte auf einen freien Platz – verbinde automatisch…' });
      scheduleJoinRetry();
    }
  },
  signal: async ({ message }) => {
    if (state.transport.mode !== 'direct') return;
    const { payload } = message;
    if (!payload) return;
    if (payload.sdp?.type === 'offer') {
      await acceptOffer({ sdp: payload.sdp, negotiationId: payload.negotiationId });
    } else if (payload.candidate && state.pc && payload.negotiationId === state.negotiationId) {
      const pc = state.pc;
      if (pc.remoteDescription) {
        await pc.addIceCandidate(payload.candidate).catch((err) => console.warn('ICE-Kandidat abgelehnt', err));
      } else {
        state.pendingCandidates.push(payload.candidate);
      }
    }
  },
};

// --- WebRTC-Empfang ---

async function acceptOffer({ sdp, negotiationId }) {
  if (state.pc && negotiationId && negotiationId === state.negotiationId) return;
  teardownPeer();
  clearTimeout(state.joinRetryTimer);
  clearTimeout(state.rejoinTimer);
  state.rejoinTimer = null;
  state.negotiationId = negotiationId;
  const pc = createPeerConnection();
  state.pc = pc;
  state.pendingCandidates = [];
  setStatus({ text: 'Verbinde mit Host…', sub: `Raum ${roomCode}` });

  clearTimeout(state.stuckTimer);
  state.stuckTimer = setTimeout(() => {
    if (state.pc === pc && pc.connectionState !== 'connected') {
      handleConnectionLost();
    }
  }, 20_000);

  const outgoingCandidates = [];
  let answerSent = false;
  const sendCandidate = (candidate) => signaling.send({
    message: { type: 'signal', payload: { candidate, negotiationId } },
  });

  pc.ontrack = (event) => {
    if (state.pc !== pc) return;
    const [stream] = event.streams;
    if (ui.video.srcObject !== stream) {
      ui.video.srcObject = stream;
      playVideo();
    }
  };
  pc.onicecandidate = (event) => {
    if (state.pc !== pc || !event.candidate) return;
    if (answerSent) sendCandidate(event.candidate);
    else outgoingCandidates.push(event.candidate);
  };
  pc.onconnectionstatechange = () => {
    if (state.pc !== pc) return;
    if (pc.connectionState === 'connected') {
      clearTimeout(state.stuckTimer);
      clearTimeout(state.disconnectTimer);
      clearTimeout(state.joinRetryTimer);
      clearTimeout(state.rejoinTimer);
      state.rejoinTimer = null;
      ui.overlay.classList.add('hidden');
      requestWakeLock();
      showControls();
    } else if (pc.connectionState === 'failed') {
      handleConnectionLost();
    } else if (pc.connectionState === 'disconnected') {
      clearTimeout(state.disconnectTimer);
      state.disconnectTimer = setTimeout(() => {
        if (state.pc === pc && pc.connectionState === 'disconnected') handleConnectionLost();
      }, DISCONNECT_GRACE_MS);
    }
  };

  try {
    await pc.setRemoteDescription(sdp);
    if (state.pc !== pc) return;
    for (const candidate of state.pendingCandidates.splice(0)) {
      await pc.addIceCandidate(candidate).catch((err) => console.warn('ICE-Kandidat abgelehnt', err));
    }
    const answer = await pc.createAnswer();
    if (state.pc !== pc) return;
    await pc.setLocalDescription(answer);
    if (state.pc !== pc) return;
    if (!signaling.send({ message: { type: 'signal', payload: { sdp: pc.localDescription, negotiationId } } })) {
      handleConnectionLost();
      return;
    }
    answerSent = true;
    outgoingCandidates.forEach(sendCandidate);
  } catch (err) {
    console.warn('Verbindungsaufbau fehlgeschlagen', err);
    if (state.pc === pc) handleConnectionLost();
  }
}

function teardownPeer() {
  clearTimeout(state.stuckTimer);
  clearTimeout(state.disconnectTimer);
  const pc = state.pc;
  state.pc = null;
  state.negotiationId = null;
  state.pendingCandidates = [];
  pc?.close();
}

function handleConnectionLost() {
  teardownPeer();
  clearTimeout(state.joinRetryTimer);
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

// --- Vollbild, Wake Lock ---

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
    if (!state.pc) joinRoom();
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
  if (state.transport.mode === 'livekit') return;
  if (!state.pc || state.pc.connectionState !== 'connected') {
    ui.pathChip.textContent = '';
    return;
  }
  const pc = state.pc;
  let stats;
  try { stats = await readConnectionStats({ pc }); } catch { return; }
  if (state.pc !== pc) return;
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
