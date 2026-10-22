/**
 * Startup smoke test without Playwright: launches Electron with LAIE_SMOKE=1,
 * waits for the renderer to load, and exits. Useful in CI or after packaging.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = process.cwd();
const electronBinary = require('electron');
const tempRoot = path.join(root, '.tmp', 'smoke');
const dataDir = path.join(tempRoot, 'data');
const userDataDir = path.join(tempRoot, 'user-data');
await fs.mkdir(dataDir, { recursive: true });
await fs.mkdir(userDataDir, { recursive: true });

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CHROME_CRASHPAD_PIPE_NAME;
env.LAIE_SMOKE = '1';
env.LAIE_DATA_DIR = dataDir;
env.LAIE_USER_DATA_DIR = userDataDir;

const child = spawn(electronBinary, ['.'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
let finished = false;

const timeout = setTimeout(() => {
  if (finished) return;
  console.error('[smoke] timed out waiting for startup');
  child.kill();
  process.exitCode = 1;
}, 45000);

child.stdout.on('data', (chunk) => {
  const text = chunk.toString();
  output += text;
  process.stdout.write(text);
  if (text.includes('[smoke] ok')) {
    finished = true;
    clearTimeout(timeout);
    child.kill();
  }
});
child.stderr.on('data', (chunk) => {
  const text = chunk.toString();
  if (!text.includes('Debugger')) process.stderr.write(text);
});

child.on('exit', (code) => {
  clearTimeout(timeout);
  if (!output.includes('[smoke] ok')) {
    console.error(`[smoke] Electron exited with ${code} before reporting success`);
    process.exitCode = 1;
  } else {
    console.log('[smoke] startup smoke test passed');
  }
});
