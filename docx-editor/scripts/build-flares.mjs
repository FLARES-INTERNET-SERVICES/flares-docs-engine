// Production UI build: never inherit the lab's .env.local socket address.
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backend = 'wss://docs.flaresinc.com/yjs';
const result = spawnSync(process.execPath, [
  path.join(root, 'node_modules/vite/bin/vite.js'), 'build',
  '--config', 'examples/vite/vite.config.ts', '--base=/editor/',
], {
  cwd: root,
  env: { ...process.env, VITE_COLLAB_BACKEND: backend, VITE_COLLAB_ENABLED: 'true' },
  stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);

const dist = path.join(root, 'examples/vite/dist');
const chunks = readdirSync(path.join(dist, 'assets')).filter(name => name.endsWith('.js'));
const source = chunks.map(name => readFileSync(path.join(dist, 'assets', name), 'utf8')).join('\n');
if (!source.includes(backend) || source.includes('ws://localhost:3200/yjs')) {
  throw new Error('Editor build did not pass the production connection-address check.');
}
writeFileSync(path.join(dist, 'flares-build.json'), JSON.stringify({
  source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  backend,
  base: '/editor/',
}, null, 2) + '\n');
console.log('Flares production editor connection address verified.');
