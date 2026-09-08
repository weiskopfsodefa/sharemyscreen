// Build-time only. End users receive the resulting server inside the installer.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const version = '1.13.6';
const sourceSha256 = '7339d5b6f5bcc73579a516c7f18f803a708b9be7514b987a8445f2d06b4defd4';
const platform = process.env.DESKTOP_PLATFORM || process.platform;
const arch = process.env.DESKTOP_ARCH || process.arch;
if (!['darwin', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch)) throw new Error('Supported targets: macOS/Windows, arm64/x64');
const cache = path.join(root, '.cache', `livekit-${version}`);
const output = path.join(root, 'desktop-resources', 'livekit');
fs.mkdirSync(cache, { recursive: true });
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
const archive = path.join(cache, 'source.tar.gz');
if (!fs.existsSync(archive)) {
  const response = await fetch(`https://github.com/livekit/livekit/archive/refs/tags/v${version}.tar.gz`);
  if (!response.ok) throw new Error(`LiveKit source download failed: ${response.status}`);
  fs.writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
}
if (crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex') !== sourceSha256) throw new Error('LiveKit source checksum mismatch');
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} failed. Build prerequisites: Go and tar. ${result.error?.message || ''}`);
}
run('tar', ['-xzf', archive, '-C', cache]);
const source = path.join(cache, `livekit-${version}`);
const binary = platform === 'win32' ? 'livekit-server.exe' : 'livekit-server';
const env = { ...process.env, GOOS: platform === 'win32' ? 'windows' : 'darwin', GOARCH: arch === 'x64' ? 'amd64' : 'arm64' };
run('go', ['build', '-trimpath', '-ldflags=-s -w', '-o', path.join(output, binary), './cmd/server'], { cwd: source, env });
fs.chmodSync(path.join(output, binary), 0o755);
fs.copyFileSync(path.join(source, 'LICENSE'), path.join(output, 'LICENSE-LiveKit.txt'));
// Preserve dependency license notices for the statically linked Go binary.
const modules = spawnSync('go', ['list', '-m', '-f', '{{.Path}}|{{.Dir}}', 'all'], { cwd: source, env, encoding: 'utf8' });
if (modules.status !== 0) throw new Error('Cannot collect LiveKit dependency notices');
let notices = '';
for (const line of modules.stdout.trim().split('\n')) {
  const [name, dir] = line.split('|');
  if (!dir) continue;
  for (const file of fs.readdirSync(dir).filter(file => /^(LICENSE|COPYING|NOTICE)(\..*)?$/i.test(file))) {
    if (fs.statSync(path.join(dir, file)).isFile()) notices += `\n\n--- ${name}: ${file} ---\n${fs.readFileSync(path.join(dir, file), 'utf8')}`;
  }
}
fs.writeFileSync(path.join(output, 'THIRD-PARTY-NOTICES.txt'), notices);
fs.writeFileSync(path.join(output, 'build.json'), JSON.stringify({ version, platform, arch, sourceSha256 }, null, 2));
console.log(`Bundled LiveKit ${version} ready for ${platform}/${arch}`);
