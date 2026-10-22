/**
 * Build verification: checks that the production artifacts exist, are
 * non-trivial, and that package.json points at the built main process.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const required = [
  'dist/main/main.js',
  'dist/preload/preload.js',
  'dist/renderer/index.html',
];

let failed = false;
function check(label, ok, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed = true;
}

for (const relative of required) {
  const absolute = path.join(root, relative);
  try {
    const stat = await fs.stat(absolute);
    check(relative, stat.isFile() && stat.size > 100, `${Math.round(stat.size / 1024)} KB`);
  } catch {
    check(relative, false, 'missing');
  }
}

try {
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  check('package.json main', pkg.main === 'dist/main/main.js', pkg.main);
} catch {
  check('package.json', false, 'unreadable');
}

try {
  const assets = await fs.readdir(path.join(root, 'dist/renderer/assets'));
  const js = assets.filter((name) => name.endsWith('.js'));
  check('renderer assets', js.length > 0, `${js.length} JS bundles`);
} catch {
  check('renderer assets', false, 'missing');
}

try {
  const html = await fs.readFile(path.join(root, 'dist/renderer/index.html'), 'utf8');
  check('renderer CSP meta', html.includes('Content-Security-Policy'));
  check('renderer entry script', /<script[^>]+src=/.test(html));
} catch {
  check('renderer index.html', false, 'unreadable');
}

console.log(failed ? '\nBuild verification failed.' : '\nBuild artifacts look good.');
process.exit(failed ? 1 : 0);
