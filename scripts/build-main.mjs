/**
 * Bundles the Electron main process and preload script with esbuild.
 * The renderer is built separately by Vite.
 */
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  external: ['electron'],
  alias: {
    '@shared': path.join(root, 'electron', 'shared'),
  },
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
};

export async function buildMain() {
  await build({
    ...shared,
    entryPoints: [path.join(root, 'electron', 'main', 'main.ts')],
    outfile: path.join(root, 'dist', 'main', 'main.js'),
  });
  await build({
    ...shared,
    // The preload runs sandboxed: only Electron APIs, no Node built-ins.
    entryPoints: [path.join(root, 'electron', 'preload', 'preload.ts')],
    outfile: path.join(root, 'dist', 'preload', 'preload.js'),
  });
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  await buildMain();
}
