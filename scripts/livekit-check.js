import { spawnSync } from 'node:child_process';

export function checkLiveKit({ env = process.env, platform = process.platform, run = spawnSync } = {}) {
  const candidates = env.LIVEKIT_BIN ? [env.LIVEKIT_BIN] : [
    'livekit-server',
    ...(platform === 'darwin' ? ['/opt/homebrew/bin/livekit-server', '/usr/local/bin/livekit-server'] : []),
  ];
  for (const binary of candidates) {
    const result = run(binary, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true, env });
    if (result.error?.code === 'ENOENT') continue;
    if (result.error || result.status !== 0) {
      return { ok: false, message: `LiveKit wurde gefunden, lässt sich aber nicht ausführen (${result.error?.code || `Exit ${result.status}`}). Pfad, Ausführungsrechte und CPU-Version prüfen.` };
    }
    const version = `${result.stdout || ''}\n${result.stderr || ''}`.match(/livekit-server\s+(?:version\s+)?v?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/i)?.[1];
    if (!version) return { ok: false, message: 'Das Programm liefert keine erkennbare LiveKit-Server-Version. LIVEKIT_BIN muss auf livekit-server zeigen, nicht auf die lk-CLI.' };
    return { ok: true, binary, version };
  }
  return { ok: false, message: env.LIVEKIT_BIN
    ? 'LiveKit wurde am angegebenen LIVEKIT_BIN-Pfad nicht gefunden. Bitte den Pfad korrigieren.'
    : 'LiveKit Server wurde nicht gefunden. Bitte installieren oder LIVEKIT_BIN auf die ausführbare Datei setzen.' };
}

export function printLiveKitCheck(result) {
  if (result.ok) {
    console.log(`LiveKit Server ${result.version} gefunden und ausführbar (${result.binary}).`);
  } else {
    console.error(result.message);
    console.error('macOS: brew install livekit');
    console.error('Windows: https://github.com/livekit/livekit/releases/latest → Windows-ZIP entpacken.');
    console.error('Anleitung: docs/livekit.md');
  }
}
