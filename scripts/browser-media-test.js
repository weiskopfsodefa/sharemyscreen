// Manual browser integration harness. Never served by the production app.
// npm run start:local must be running on port 3210. Open localhost:3299/host.
// Only this test page replaces the capture picker with a moving canvas.
import http from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
const injection = `<script>
window.addEventListener('DOMContentLoaded', () => {
  const video = document.querySelector('#stream');
  if (!video) return;
  for (const [label, width, height] of [['Test: 360p', 640, 360], ['Test: Nativ', 2560, 1440]]) {
    const button = document.createElement('button'); button.textContent = label;
    button.style.cssText = 'position:relative;z-index:9999';
    button.onclick = () => { video.style.width = width + 'px'; video.style.height = height + 'px'; };
    document.body.append(button);
  }
});
const canvas = document.createElement('canvas');
canvas.width = 2560; canvas.height = 1440;
const ctx = canvas.getContext('2d');
ctx.scale(2, 2); // Native 1440p source exercises simulcast layers.
let frame = 0;
const captures = [];
setInterval(() => {
  ctx.fillStyle = '#102030'; ctx.fillRect(0, 0, 1280, 720);
  ctx.fillStyle = '#ffaa2b'; ctx.fillRect((frame++ * 12) % 1180, 200, 100, 200);
  ctx.fillStyle = 'white'; ctx.font = '48px sans-serif'; ctx.fillText('Local SFU test ' + frame, 40, 90);
  for (const track of captures) if (track.readyState === 'live') track.requestFrame();
}, 1000 / 30);
navigator.mediaDevices.getDisplayMedia = async () => {
  const stream = canvas.captureStream(0);
  captures.push(stream.getVideoTracks()[0]);
  return stream;
};
</script>`;
const server = http.createServer(async (req, res) => {
  try {
    const upstream = await fetch('http://127.0.0.1:3210' + req.url);
    let body = Buffer.from(await upstream.arrayBuffer());
    const contentType = upstream.headers.get('content-type') || '';
    if (req.url === '/js/media-client.js') {
      body = Buffer.from(body.toString().replace('this.active = false;', 'this.active = false; monitor(this);') + `
function monitor(client) {
  const output = document.createElement('pre'); output.id = 'media-test-stats'; document.body.append(output);
  const timer = setInterval(async () => {
    const track = client.localTrack || client.remoteTrack;
    if (!track) return;
    const report = await track.getRTCStatsReport();
    const rows = [...report.values()].filter(s => s.type === 'outbound-rtp' || s.type === 'inbound-rtp')
      .map(({type, rid, frameWidth, frameHeight, framesPerSecond, bytesSent, bytesReceived, jitterBufferDelay, jitterBufferEmittedCount}) =>
        ({type, rid, frameWidth, frameHeight, framesPerSecond, bytesSent, bytesReceived, jitterBufferDelay, jitterBufferEmittedCount}));
    output.textContent = JSON.stringify({encodings: client.localTrack?.sender?.getParameters().encodings,
      bufferTarget: client.remoteTrack?.receiver?.jitterBufferTarget, rows});
  }, 1000);
  window.addEventListener('pagehide', () => clearInterval(timer), {once: true});
}
`);
    }
    if (contentType.includes('text/html')) body = Buffer.from(body.toString().replace('<script type="module">', injection + '<script type="module">'));
    res.writeHead(upstream.status, { 'content-type': contentType, 'cache-control': 'no-store' }); res.end(body);
  } catch { res.writeHead(502); res.end('Start the local server first.'); }
});
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', client => {
  const upstream = new WebSocket('ws://127.0.0.1:3210/ws');
  const queued = [];
  client.on('message', data => upstream.readyState === WebSocket.OPEN ? upstream.send(data) : queued.push(data));
  upstream.on('open', () => queued.forEach(data => upstream.send(data)));
  upstream.on('message', data => { if (client.readyState === WebSocket.OPEN) client.send(data, { binary: false }); });
  client.on('close', () => upstream.close()); upstream.on('close', () => client.close());
  client.on('error', () => upstream.close()); upstream.on('error', () => client.close());
});
server.listen(3299, '127.0.0.1', () => console.log('Synthetic capture test: http://localhost:3299/host'));
