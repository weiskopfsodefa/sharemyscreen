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
  pathChip: document.getElementById('path-chip'),
  controls: document.getElementById('controls'),
  muteBtn: document.getElementById('mute-btn'),
  fullscreenBtn: document.getElementById('fullscreen-btn'),
};

const roomCode = location.pathname.split('/').pop().toUpperCase();
const VIEWER_ID_KEY = `sms-viewer-${roomCode}`;

const state = {
  viewerId: sessionStorage.getItem(VIEWER_ID_KEY) || null,
  pc: null,
  wakeLock: null,
  rejoinTimer: null,
  fadeTimer: null,
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

function joinRoom() {
  signaling.send({ message: { type: 'viewer:join', code: roomCode, viewerId: state.viewerId } });
}

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
    } else if (payload.candidate && state.pc) {
      state.pc.addIceCandidate(payload.candidate).catch(() => {});
    }
  },
};

// --- WebRTC-Empfang ---

async function acceptOffer({ sdp }) {
  teardownPeer();
  const pc = createPeerConnection();
  state.pc = pc;
  setStatus({ text: 'Verbinde mit Host…', sub: `Raum ${roomCode}` });

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
  signaling.connect();
}
