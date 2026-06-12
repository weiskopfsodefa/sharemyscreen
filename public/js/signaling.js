const MAX_RETRY_DELAY_MS = 10_000;

export class SignalingClient {
  constructor({ onOpen, onMessage, onStatusChange } = {}) {
    this.onOpen = onOpen;
    this.onMessage = onMessage;
    this.onStatusChange = onStatusChange;
    this.retryDelayMs = 1000;
    this.socket = null;
  }

  connect() {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    this.socket = new WebSocket(`${protocol}://${location.host}/ws`);

    this.socket.addEventListener('open', () => {
      this.retryDelayMs = 1000;
      this.onStatusChange?.({ status: 'online' });
      this.onOpen?.();
    });

    this.socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      this.onMessage?.({ message });
    });

    this.socket.addEventListener('close', () => {
      this.onStatusChange?.({ status: 'offline' });
      this.scheduleReconnect();
    });

    this.socket.addEventListener('error', () => {
      this.socket?.close();
    });
  }

  scheduleReconnect() {
    setTimeout(() => this.connect(), this.retryDelayMs);
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, MAX_RETRY_DELAY_MS);
  }

  send({ message }) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }
}
