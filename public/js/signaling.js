const MAX_RETRY_DELAY_MS = 10_000;
const CONNECT_TIMEOUT_MS = 15_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_TIMEOUT_MS = 45_000;

export class SignalingClient {
  constructor({ onOpen, onMessage, onStatusChange } = {}) {
    Object.assign(this, { onOpen, onMessage, onStatusChange });
    this.retryDelayMs = 1000;
    this.socket = null;
    this.retryTimer = null;
    this.connectTimer = null;
    this.heartbeatTimer = null;
  }

  connect() {
    if (this.socket) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${protocol}://${location.host}/ws`);
    this.socket = socket;
    this.connectTimer = setTimeout(() => this.disconnect(socket), CONNECT_TIMEOUT_MS);

    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      clearTimeout(this.connectTimer);
      this.retryDelayMs = 1000;
      this.lastPong = Date.now();
      this.heartbeatTimer = setInterval(() => {
        if (Date.now() - this.lastPong > HEARTBEAT_TIMEOUT_MS) {
          this.disconnect(socket);
        } else {
          this.send({ message: { type: 'ping' } });
        }
      }, HEARTBEAT_INTERVAL_MS);
      this.onStatusChange?.({ status: 'online' });
      this.onOpen?.();
    });

    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (!message || typeof message.type !== 'string') return;
      if (message.type === 'pong') {
        this.lastPong = Date.now();
        return;
      }
      Promise.resolve().then(() => this.onMessage?.({ message }))
        .catch((err) => console.warn('Signaling-Nachricht fehlgeschlagen', err));
    });

    socket.addEventListener('close', () => this.disconnect(socket));
    socket.addEventListener('error', () => this.disconnect(socket));
  }

  disconnect(socket) {
    if (this.socket !== socket) return;
    this.socket = null;
    clearTimeout(this.connectTimer);
    clearInterval(this.heartbeatTimer);
    socket.close();
    this.onStatusChange?.({ status: 'offline' });
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, this.retryDelayMs);
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, MAX_RETRY_DELAY_MS);
  }

  send({ message }) {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      this.disconnect(socket);
      return false;
    }
  }
}
