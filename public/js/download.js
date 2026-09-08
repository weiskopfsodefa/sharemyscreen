const container = document.getElementById('downloads');
const status = document.getElementById('download-status');
try {
  const response = await fetch('/downloads.json');
  if (!response.ok) throw new Error('Downloads unavailable');
  const downloads = await response.json();
  let count = 0;
  for (const [key, label] of Object.entries({ 'mac-arm64': 'macOS · Apple Silicon', 'mac-x64': 'macOS · Intel', 'windows-x64': 'Windows' })) {
    const url = downloads[key];
    const valid = typeof url === 'string' && url.startsWith('https://github.com/weiskopfsodefa/sharemyscreen/releases/download/');
    const element = document.createElement(valid ? 'a' : 'button');
    element.className = 'btn btn-primary'; element.textContent = label;
    if (valid) { element.href = url; count++; } else { element.disabled = true; }
    container.append(element);
  }
  status.textContent = count ? 'Installer herunterladen und auf dem Host-Laptop öffnen.' : 'Die Host-App wird gerade vorbereitet. Öffentliche Installer sind noch nicht verfügbar. Der Direktmodus im Browser ist schon nutzbar.';
} catch { status.textContent = 'Downloads konnten nicht geladen werden. Bitte später erneut versuchen.'; }
