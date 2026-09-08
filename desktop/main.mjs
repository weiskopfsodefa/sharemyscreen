import { app, BrowserWindow, ipcMain, dialog, Menu, session, desktopCapturer, utilityProcess } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { localAddresses } from '../scripts/local-config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const setupURL = new URL('./setup.html', import.meta.url).href;
const hostOrigin = 'http://localhost:3210';
let window;
let service;
let starting = false;
let quitting = false;
let lastError = '';
const trustedSetup = event => event.sender === window?.webContents && event.senderFrame?.url === setupURL;
const hostFrame = frame => frame && frame === window?.webContents.mainFrame && new URL(frame.url).origin === hostOrigin;

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.show(); window?.focus(); });
  app.whenReady().then(createWindow);
}

async function stopService() {
  const child = service;
  service = null;
  if (!child?.pid) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill(); resolve(); }, 4000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.postMessage('stop');
  });
}

async function startService(ip) {
  const binary = path.join(app.isPackaged ? process.resourcesPath : path.join(here, '../desktop-resources'), 'livekit', process.platform === 'win32' ? 'livekit-server.exe' : 'livekit-server');
  const dataDir = path.join(app.getPath('userData'), 'local-server');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const log = fs.createWriteStream(path.join(dataDir, 'app.log'), { flags: 'w', mode: 0o600 });
  const child = utilityProcess.fork(path.join(here, 'service.mjs'), [], {
    serviceName: 'sharemyscreen local server', stdio: 'pipe',
    env: { ...process.env, LOCAL_MEDIA_IP: ip, LIVEKIT_BIN: binary, SMS_DATA_DIR: dataDir },
  });
  service = child;
  child.stdout?.pipe(log, { end: false }); child.stderr?.pipe(log, { end: false });
  await new Promise((resolve, reject) => {
    let ready = false;
    const timer = setTimeout(() => reject(new Error('Der Start dauert zu lange. Bitte erneut versuchen.')), 25000);
    child.on('message', message => {
      if (service !== child) return;
      if (message.type === 'ready') { ready = true; clearTimeout(timer); resolve(); }
      if (message.type === 'error') {
        lastError = message.message;
        if (!ready) { clearTimeout(timer); reject(new Error(lastError)); }
        else if (!quitting && !window.isDestroyed()) { stopService().then(() => window.loadURL(setupURL)); }
      }
    });
    child.once('exit', () => {
      log.end(); clearTimeout(timer);
      if (!ready) reject(new Error(lastError || 'Der lokale Dienst konnte nicht gestartet werden.'));
      else if (service === child && !quitting) {
        service = null;
        lastError = 'Die Verbindung zum lokalen Dienst wurde beendet. Bitte erneut starten.';
        if (!window.isDestroyed()) window.loadURL(setupURL);
      }
    });
  });
}

async function createWindow() {
  window = new BrowserWindow({ width: 1200, height: 850, minWidth: 720, minHeight: 580,
    title: 'sharemyscreen Host', backgroundColor: '#140f08',
    webPreferences: { preload: path.join(here, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== setupURL && !url.startsWith(`${hostOrigin}/`)) event.preventDefault();
  });
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    callback(contents === window.webContents && contents.getURL().startsWith(`${hostOrigin}/`)
      && ['media', 'display-capture', 'fullscreen', 'clipboard-sanitized-write'].includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((contents, permission, origin) =>
    contents === window.webContents && origin === hostOrigin && ['media', 'display-capture', 'fullscreen', 'clipboard-sanitized-write'].includes(permission));
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!hostFrame(request.frame) || !request.userGesture) return callback({});
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
      // Native menu fallback (Windows / older macOS). Never silently select a source.
      const source = await new Promise(resolve => {
        let chosen;
        const menu = Menu.buildFromTemplate([
          ...sources.map(item => ({ label: item.name, click: () => { chosen = item; } })),
          { type: 'separator' }, { label: 'Abbrechen' },
        ]);
        menu.popup({ window, callback: () => resolve(chosen) });
      });
      callback(source && hostFrame(request.frame) ? { video: source } : {});
    } catch {
      callback({});
      dialog.showMessageBox(window, { type: 'info', message: 'Bildschirmfreigabe nicht möglich', detail: 'Bitte die Bildschirmaufnahme für sharemyscreen in den Systemeinstellungen erlauben und die App anschließend erneut öffnen.' });
    }
  }, { useSystemPicker: true });
  ipcMain.handle('setup:state', event => {
    if (!trustedSetup(event)) throw new Error('Nicht erlaubt');
    return { addresses: localAddresses(), error: lastError };
  });
  ipcMain.handle('setup:start', async (event, ip) => {
    if (!trustedSetup(event) || starting || !localAddresses().some(entry => entry.address === ip)) return { error: 'Bitte ein verbundenes Netzwerk wählen.' };
    starting = true; lastError = '';
    try {
      await stopService();
      await startService(ip);
      if (!quitting) setImmediate(() => window.loadURL(`${hostOrigin}/host?desktop=1`));
      return { ok: true };
    } catch (error) { lastError = error.message; await stopService(); return { error: lastError }; }
    finally { starting = false; }
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: 'Host', submenu: [
      { label: 'Netzwerk wechseln (Übertragung beenden)', click: async () => { await stopService(); lastError = ''; if (!quitting) window.loadURL(setupURL); } },
      { type: 'separator' }, { role: 'quit' },
    ] },
    { role: 'editMenu' }, { role: 'viewMenu' },
  ]));
  await window.loadURL(setupURL);
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault(); quitting = true;
  stopService().finally(() => app.quit());
});
