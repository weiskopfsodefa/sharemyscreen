import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { formatBitrate, PATH_LABELS } from '../public/js/webrtc.js';

// Echte Client-Logik mit kontrollierter Uhr und WebRTC-/WebSocket-Grenzen.
// So lassen sich verlorene Nachrichten und überlappende Aufbauten reproduzieren.
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function setup(file) {
  let now = 0;
  let nextTimer = 0;
  const timers = new Map();
  const schedule = (fn, delay, repeat = false) => {
    const id = ++nextTimer;
    timers.set(id, { fn, at: now + delay, delay, repeat });
    return id;
  };
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, {
        value: '', textContent: '', style: {},
        classList: { add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x), toggle() {} },
        addEventListener() {}, append() {}, play: async () => {},
      });
    }
    return elements.get(id);
  }
  const pcs = [];
  class Peer {
    constructor() { this.connectionState = 'new'; this.remoteDescription = null; this.candidates = []; pcs.push(this); }
    close() { this.connectionState = 'closed'; this.onconnectionstatechange?.(); }
    addTrack() {}
    getSenders() { return []; }
    async createOffer() { return { type: 'offer' }; }
    async createAnswer() { return { type: 'answer' }; }
    async setRemoteDescription(sdp) { this.remoteDescription = sdp; }
    async setLocalDescription(sdp) {
      this.localDescription = sdp;
      // Absichtlich früh: SDP muss trotzdem vor dem ICE-Kandidaten gesendet werden.
      this.onicecandidate?.({ candidate: { candidate: 'local' } });
    }
    async addIceCandidate(candidate) { this.candidates.push(candidate); }
    change(state) { this.connectionState = state; this.onconnectionstatechange?.(); }
  }
  const sockets = [];
  class Socket {
    static OPEN = 1;
    constructor() { this.readyState = 0; this.handlers = {}; this.sent = []; sockets.push(this); }
    addEventListener(name, fn) { this.handlers[name] = fn; }
    emit(name, event = {}) { this.handlers[name]?.(event); }
    open() { this.readyState = 1; this.emit('open'); }
    close() { this.readyState = 3; this.emit('close'); }
    send(raw) { this.sent.push(JSON.parse(raw)); }
  }
  class Signaling {
    constructor(options) { this.options = options; this.sent = []; this.online = true; }
    connect() {}
    send({ message }) { if (!this.online) return false; this.sent.push(message); return true; }
  }
  const context = vm.createContext({
    URLSearchParams,
    document: { getElementById: element, querySelectorAll: () => [], createElement: () => ({}), addEventListener() {} },
    location: { pathname: '/ABC123', protocol: 'http:', host: 'localhost' },
    localStorage: { getItem: () => null, setItem() {} }, sessionStorage: { getItem: () => null, setItem() {} },
    navigator: { userAgent: '', wakeLock: { request: async () => ({}) } },
    performance: { now: () => now }, Date: { now: () => now },
    crypto: { randomUUID: () => `attempt-${pcs.length}` },
    setTimeout: (fn, delay) => schedule(fn, delay), clearTimeout: id => timers.delete(id),
    setInterval: (fn, delay) => schedule(fn, delay, true), clearInterval: id => timers.delete(id),
    SignalingClient: Signaling, WebSocket: Socket, createPeerConnection: () => new Peer(),
    readConnectionStats: async () => ({}), formatBitrate, PATH_LABELS,
    console: { warn() {} },
  });
  const source = fs.readFileSync(new URL(`../public/js/${file}.js`, import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace('export class ', 'class ');
  const expose = file === 'signaling' ? '{ SignalingClient }'
    : file === 'viewer' ? '{ state, signaling, MESSAGE_HANDLERS, acceptOffer, joinRoom, handleConnectionLost }'
    : '{ state, signaling, MESSAGE_HANDLERS, addViewer, removeViewer, stopShare }';
  vm.runInContext(`${source}\nglobalThis.api = ${expose};`, context);
  const advance = async ms => {
    const end = now + ms;
    while (true) {
      const pending = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!pending) break;
      const [id, timer] = pending;
      now = timer.at;
      if (timer.repeat) timer.at += timer.delay; else timers.delete(id);
      await timer.fn(); await flush();
    }
    now = end; await flush();
  };
  return { ...context.api, pcs, sockets, elements, advance };
}

const offer = (id = 'one') => ({ sdp: { type: 'offer' }, negotiationId: id });
const joins = s => s.signaling.sent.filter(m => m.type === 'viewer:join');

test('Viewer wiederholt Beitritt auch nach Bestätigung ohne Angebot', async () => {
  const s = setup('viewer'); await flush();
  s.handleConnectionLost(); await s.advance(2000);
  s.MESSAGE_HANDLERS['viewer:joined']({ message: { viewerId: '1234abcd', hostOnline: true } });
  await s.advance(30000);
  assert.equal(joins(s).length, 4);
});

test('Verlorener Join bei offline WebSocket wird erneut versucht', async () => {
  const s = setup('viewer'); await flush(); s.signaling.online = false;
  s.handleConnectionLost(); await s.advance(12000); assert.equal(joins(s).length, 0);
  s.signaling.online = true; await s.advance(10000); assert.equal(joins(s).length, 1);
});

test('Aufbau-Timeout und SDP-Fehler starten neue Versuche', async () => {
  const s = setup('viewer'); await flush();
  await s.acceptOffer(offer()); await s.advance(22000);
  assert.equal(s.pcs[0].connectionState, 'closed'); assert.equal(joins(s).length, 1);
  const pending = s.acceptOffer(offer('two'));
  s.pcs[1].createAnswer = async () => { throw new Error('SDP'); };
  await pending; await s.advance(2000); assert.equal(joins(s).length, 2);
});

test('Neue Verbindung löscht alte Rejoin-Timer und ignoriert fremde ICE-Kandidaten', async () => {
  const s = setup('viewer'); await flush(); s.handleConnectionLost();
  await s.acceptOffer(offer()); const pc = s.state.pc; pc.change('connected');
  await s.MESSAGE_HANDLERS.signal({ message: { payload: { negotiationId: 'old', candidate: {} } } });
  await s.advance(30000);
  assert.equal(joins(s).length, 0); assert.equal(pc.candidates.length, 0);
  assert.equal(s.signaling.sent[0].payload.sdp.type, 'answer');
  assert.equal(s.signaling.sent[1].payload.candidate.candidate, 'local');
});

test('Laufendes Video bleibt bei Raumablauf und WS-Reconnect erhalten', async () => {
  const s = setup('viewer'); await flush(); await s.acceptOffer(offer());
  const pc = s.state.pc; pc.change('connected');
  s.MESSAGE_HANDLERS['room:closed'](); assert.equal(s.state.pc, pc);
  s.signaling.options.onOpen(); assert.equal(joins(s).at(-1).needsOffer, false);
  s.MESSAGE_HANDLERS['viewer:joined']({ message: { viewerId: '1234abcd' } });
  await s.advance(30000); assert.equal(joins(s).length, 1);
});

test('WS-Reconnect registriert Viewer auch während laufender Verhandlung ohne neues Angebot', async () => {
  const s = setup('viewer'); await flush(); await s.acceptOffer(offer());
  s.signaling.options.onOpen(); assert.equal(joins(s).at(-1).needsOffer, false);
});

test('Überholte asynchrone Antwort darf neueren Peer nicht stören', async () => {
  const s = setup('viewer'); await flush();
  await s.acceptOffer(offer('first'));
  let finish;
  s.state.pc.createAnswer = () => new Promise(resolve => { finish = resolve; });
  // Für einen neuen Aufbau die nächste Peer-Methode beim ersten await austauschen.
  const older = s.acceptOffer(offer('second'));
  s.state.pc.createAnswer = () => new Promise(resolve => { finish = resolve; });
  await flush();
  await s.acceptOffer(offer('third')); const latest = s.state.pc;
  finish({ type: 'answer' }); await older;
  assert.equal(s.state.pc, latest);
  assert.equal(s.signaling.sent.filter(m => m.payload.sdp && m.payload.negotiationId === 'second').length, 0);
});

async function host() {
  const s = setup('host'); s.state.stream = { getTracks: () => [] };
  s.addViewer({ viewerId: 'tablet' }); await flush(); return s;
}

test('Host behält laufenden Peer nach viewer:left, Rejoin erzeugt keinen Ersatz', async () => {
  const s = await host(); const pc = s.pcs[0]; pc.change('connected');
  s.removeViewer({ viewerId: 'tablet' }); await s.advance(60000);
  assert.equal(pc.connectionState, 'connected');
  s.addViewer({ viewerId: 'tablet', needsOffer: false }); await flush();
  assert.equal(s.pcs.length, 1);
});

test('Doppelte Joins ersetzen laufenden Aufbau nicht; Host-Timeout versucht neu', async () => {
  const s = await host();
  s.addViewer({ viewerId: 'tablet' }); await flush(); assert.equal(s.pcs.length, 1);
  await s.advance(28000); assert.equal(s.pcs.length, 2);
  assert.equal(s.signaling.sent[0].payload.sdp.type, 'offer');
  assert.equal(s.signaling.sent[1].payload.candidate.candidate, 'local');
});

test('Host erholt sich von failed; entfernte Viewer und Stop starten keine neuen Versuche', async () => {
  const s = await host(); s.pcs[0].change('failed'); await s.advance(3000);
  assert.equal(s.pcs.length, 2);
  s.pcs[1].change('failed'); s.stopShare(); await s.advance(30000); assert.equal(s.pcs.length, 2);
  const gone = await host(); gone.removeViewer({ viewerId: 'tablet' }); gone.pcs[0].change('failed');
  await gone.advance(30000); assert.equal(gone.state.viewers.size, 0); assert.equal(gone.pcs.length, 1);
});

test('WebSocket-Verbindungsaufbau hat Timeout; alte Socket-Events beschädigen neuen Socket nicht', async () => {
  const s = setup('signaling'); const client = new s.SignalingClient(); client.connect(); client.connect();
  assert.equal(s.sockets.length, 1); await s.advance(16000); assert.equal(s.sockets.length, 2);
  s.sockets[1].open(); s.sockets[0].emit('error'); s.sockets[0].emit('close');
  assert.equal(client.socket, s.sockets[1]);
});

test('Fehlende Pong-Antworten erneuern scheinbar offene WebSockets', async () => {
  const s = setup('signaling'); const client = new s.SignalingClient(); client.connect(); s.sockets[0].open();
  await s.advance(51000); assert.equal(s.sockets.length, 2);
  s.sockets[1].open(); await s.advance(20000);
  s.sockets[1].emit('message', { data: '{"type":"pong"}' }); await s.advance(30000);
  assert.equal(client.socket, s.sockets[1]);
});

test('Kurze Funkunterbrechungen erhalten den Peer; jede neue Unterbrechung erhält ihre volle Frist', async () => {
  const s = setup('viewer'); await flush(); await s.acceptOffer(offer()); const pc = s.state.pc;
  pc.change('connected'); pc.change('disconnected'); await s.advance(2000);
  pc.change('connected'); pc.change('disconnected'); await s.advance(2500);
  assert.equal(s.state.pc, pc);
  pc.change('connected'); await s.advance(10000); assert.equal(s.state.pc, pc);
  const h = await host(); h.pcs[0].change('connected'); h.pcs[0].change('disconnected');
  await h.advance(3000); h.pcs[0].change('connected'); await h.advance(30000);
  assert.equal(h.pcs.length, 1);
});
