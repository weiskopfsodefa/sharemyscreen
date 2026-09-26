const base = require('./electron-builder.cjs');

// Public macOS installers must never silently fall back to unsigned builds.
module.exports = {
  ...base,
  forceCodeSigning: true,
  mac: {
    ...base.mac,
    type: 'distribution',
    hardenedRuntime: true,
    notarize: true,
  },
  beforePack: async context => {
    if (context.electronPlatformName !== 'darwin') {
      throw new Error('This release configuration is for macOS only.');
    }
    // Locally, use the signing certificate and notarytool profile in Keychain.
    // CI imports a .p12 and supplies the Apple credentials through secrets.
    const required = process.env.APPLE_KEYCHAIN_PROFILE?.trim()
      ? []
      : ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'];
    if (process.env.CSC_LINK) required.push('CSC_KEY_PASSWORD');
    const missing = required.filter(name => !process.env[name]?.trim());
    if (missing.length) {
      throw new Error(`Missing macOS release secrets: ${missing.join(', ')}. See docs/host-app.md.`);
    }
    await base.beforePack(context);
  },
};
