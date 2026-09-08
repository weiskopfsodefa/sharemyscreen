const fs = require('node:fs');
const path = require('node:path');
module.exports = {
  appId: 'de.sharemyscreen.host',
  productName: 'sharemyscreen Host',
  directories: { output: 'dist-desktop' },
  artifactName: 'sharemyscreen-Host-${version}-${os}-${arch}.${ext}',
  files: ['desktop/**/*', 'public/**/*', 'scripts/local-config.js', 'scripts/livekit-check.js', 'server.js', 'media-config.js', 'package.json', 'LICENSE'],
  extraResources: [{ from: 'desktop-resources/livekit', to: 'livekit' }],
  asar: true,
  beforePack: async context => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'desktop-resources/livekit/build.json')));
    const arch = require('builder-util').Arch[context.arch];
    if (manifest.platform !== context.electronPlatformName || manifest.arch !== arch) throw new Error('Bundled LiveKit architecture does not match this installer. Run desktop:prepare for the target first.');
  },
  mac: { icon: 'desktop/icon.icns', target: ['dmg'], category: 'public.app-category.utilities',
    extendInfo: { NSScreenCaptureUsageDescription: 'Teile deinen Bildschirm mit Tablets im lokalen Netzwerk.', NSLocalNetworkUsageDescription: 'Verbinde die Tablets im selben WLAN mit deinem Bildschirm.' },
    binaries: ['Contents/Resources/livekit/livekit-server'],
  },
  win: { icon: 'desktop/icon.ico', target: ['nsis'] },
  nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, createDesktopShortcut: true },
};
