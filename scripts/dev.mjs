/**
 * Development runner: Vite dev server + watched Electron main/preload builds.
 * Renderer edits hot-reload; main/preload edits rebuild and restart Electron.
 */
import { createServer } from 'vite';
import { context } from 'esbuild';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronBinary = require('electron');

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  external: ['electron'],
  alias: { '@shared': path.join(root, 'electron', 'shared') },
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': JSON.stringify('development') },
};

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CHROME_CRASHPAD_PIPE_NAME;

let electronProcess = null;
let rendererUrl = 'http://127.0.0.1:5199';
let restartting = false;

function startElectron() {
  if (electronProcess) {
    electronProcess.removeAllListeners('exit');
    electronProcess.kill();
    electronProcess = null;
  }
  electronProcess = spawn(electronBinary, ['.'], {
    cwd: root,
    env: { ...env, ELECTRON_RENDERER_URL: rendererUrl },
    stdio: 'inherit',
  });
  electronProcess.on('exit', (code) => {
    if (!restartting && code !== null && code !== 0) {
      console.error(`[dev] Electron exited with code ${code}`);
    }
  });
}

function scheduleRestart() {
  if (restartting) return;
  restartting = true;
  setTimeout(() => {
    restartting = false;
    console.log('[dev] main/preload rebuilt — restarting Electron');
    startElectron();
  }, 250);
}

const restartPlugin = {
  name: 'restart-electron',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length === 0) scheduleRestart();
    });
  },
};

async function main() {
  const server = await createServer({
    configFile: path.join(root, 'vite.config.ts'),
    server: { port: 5199, strictPort: true },
  });
  await server.listen();
  const urls = server.resolvedUrls?.local ?? [];
  rendererUrl = urls[0] ?? rendererUrl;
  console.log(`[dev] Renderer: ${rendererUrl}`);

  const mainContext = await context({
    ...shared,
    entryPoints: [path.join(root, 'electron', 'main', 'main.ts')],
    outfile: path.join(root, 'dist', 'main', 'main.js'),
    plugins: [restartPlugin],
  });
  const preloadContext = await context({
    ...shared,
    entryPoints: [path.join(root, 'electron', 'preload', 'preload.ts')],
    outfile: path.join(root, 'dist', 'preload', 'preload.js'),
  });
  await preloadContext.rebuild();
  await preloadContext.watch();
  await mainContext.watch();
  // The initial main build already ran; start once after it finishes.
  await new Promise((resolve) => setTimeout(resolve, 400));
  if (!electronProcess) startElectron();

  const shutdown = async () => {
    console.log('\n[dev] Shutting down');
    if (electronProcess) electronProcess.kill();
    await Promise.allSettled([mainContext.dispose(), preloadContext.dispose(), server.close()]);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((error) => {
  console.error('[dev] Failed to start:', error);
  process.exit(1);
});
