/**
 * Core desktop E2E: project, editor save, terminal execution, real model chat,
 * backup creation, and restart persistence. Uses API polling with short
 * intervals to avoid long idle waits on low-memory machines.
 */
import { _electron as electron } from 'playwright';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { stageApp } from '../../scripts/stage-app.mjs';

const outputDir = path.join(process.cwd(), 'test-results');
await fs.mkdir(outputDir, { recursive: true });
const staged = await stageApp({ freshData: true });
const errors = [];
const steps = [];

function logStep(name, detail = '') {
  steps.push({ name, detail });
  console.log(`[core-e2e] ${name}${detail ? `: ${detail}` : ''}`);
}

async function unloadModel() {
  try {
    await fetch('http://127.0.0.1:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gemma4:12b', keep_alive: 0 }),
    });
  } catch {
    /* best effort */
  }
}

let app = null;
let page = null;

async function launch() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CHROME_CRASHPAD_PIPE_NAME;
  env.ELECTRON_ENABLE_LOGGING = '1';
  env.LAIE_DISABLE_GPU = '1';
  env.LAIE_USER_DATA_DIR = staged.userDataDir;
  env.LAIE_DATA_DIR = staged.dataDir;
  app = await electron.launch({
    executablePath: path.join(staged.electronDir, 'electron.exe'),
    args: [staged.appDir],
    cwd: staged.appDir,
    env,
    timeout: 60000,
  });
  app.process().stderr?.on('data', (chunk) => {
    const text = chunk.toString();
    if (!text.includes('Debugger')) process.stderr.write(`[main:err] ${text}`);
  });
  app.process().stdout?.on('data', (chunk) => {
    const text = chunk.toString();
    if (text.includes('close event') || text.includes('before-quit')) {
      console.log(`[main] ${text.trim()}`);
    }
  });
  page = await app.firstWindow({ timeout: 60000 });
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('close', () => console.log('[core-e2e] page closed'));
  await page.waitForSelector('.app', { timeout: 60000 });
}

async function shot(name) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(outputDir, `${name}.png`) }).catch(() => undefined);
  }
}

async function pollMessages(projectId, predicate, timeout = 180000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (page.isClosed()) throw new Error('page closed while polling messages');
    const messages = await page.evaluate(async (id) => {
      const chats = await window.desktop.chats.list(id);
      const all = [];
      for (const chat of chats) {
        all.push(...(await window.desktop.chats.messages(id, chat.id)));
      }
      return all;
    }, projectId);
    const result = predicate(messages);
    if (result) return messages;
    await page.waitForTimeout(700);
  }
  throw new Error('timed out waiting for chat messages');
}

try {
  await launch();
  await page.waitForSelector('.dashboard', { timeout: 30000 });
  await shot('core-01-dashboard');

  await page.locator('.dash-actions').getByRole('button', { name: /add existing folder/i }).click();
  await page.fill('#project-name', 'Core Project');
  await page.fill('#project-path', staged.projectA);
  await page.getByRole('button', { name: /^add project$/i }).click();
  await page.waitForSelector('.workspace', { timeout: 30000 });
  const projectId = await page.evaluate(async () => (await window.desktop.projects.list())[0].id);
  logStep('Project opened');

  // Editor open + save
  await page.locator('.tree-row', { hasText: 'README.md' }).first().click();
  await page.waitForSelector('.monaco-editor', { timeout: 60000 });
  await page.waitForTimeout(700);
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('# Core E2E\n\nSaved by the automated editor test.\n');
  await page.keyboard.press('Control+S');
  await page.waitForTimeout(1200);
  const readme = await fs.readFile(path.join(staged.projectA, 'README.md'), 'utf8');
  if (!readme.includes('automated editor test')) throw new Error('editor save failed');
  logStep('Editor saved a file');
  await shot('core-02-editor');

  // Terminal command
  await page.keyboard.press('Control+J');
  await page.waitForSelector('.terminal-dock .xterm', { timeout: 30000 });
  await page.waitForTimeout(1200);
  await page.locator('.terminal-host').click();
  await page.keyboard.type('echo core-e2e> terminal-core.txt');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2200);
  const terminalContent = await fs
    .readFile(path.join(staged.projectA, 'terminal-core.txt'), 'utf8')
    .catch(() => '');
  if (!terminalContent.includes('core-e2e')) throw new Error('terminal command failed');
  logStep('Terminal executed a command', terminalContent.trim());
  await shot('core-03-terminal');

  // Real model chat
  await page.locator('.section-header').filter({ hasText: 'Chats' }).getByTitle(/new chat/i).click();
  await page.waitForSelector('.composer textarea', { timeout: 20000 });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const count = await page.evaluate(async (id) => (await window.desktop.chats.list(id)).length, projectId);
    if (count > 0) break;
    await page.waitForTimeout(200);
  }
  await page.waitForTimeout(500);
  await page.fill('.composer textarea', 'Reply with exactly one word: pong');
  await page.keyboard.press('Enter');
  await pollMessages(
    projectId,
    (messages) =>
      messages.some(
        (message) => message.role === 'assistant' && message.content.toLowerCase().includes('pong'),
      ),
    240000,
  );
  logStep('Real model replied', 'gemma4:12b');
  await page.waitForTimeout(1500);
  await shot('core-04-chat');
  await unloadModel();

  // Backup through Settings
  await page.locator('.titlebar').getByTitle('Settings').click();
  await page.waitForSelector('.modal', { timeout: 20000 });
  await page.getByRole('button', { name: /data & storage/i }).click();
  await page.getByRole('button', { name: /create verified backup/i }).click();
  await page.waitForSelector('.toast', { timeout: 60000 });
  await page.waitForTimeout(600);
  const backupRows = await page.locator('.backup-row').count();
  if (backupRows === 0) throw new Error('backup not listed');
  logStep('Backup created', `${backupRows} listed`);
  await shot('core-05-backups');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // Restart
  await app.close();
  app = null;
  await launch();
  await page.waitForSelector('.workspace', { timeout: 60000 });
  await pollMessages(
    projectId,
    (messages) =>
      messages.some(
        (message) => message.role === 'assistant' && message.content.toLowerCase().includes('pong'),
      ),
    60000,
  );
  await shot('core-06-restart');
  logStep('Restart persistence verified');

  console.log(JSON.stringify({ ok: true, steps, errors }, null, 2));
} catch (error) {
  console.error('[core-e2e] FAILED', error);
  await shot('core-failure');
  console.log(JSON.stringify({ ok: false, error: error.message, steps, errors }, null, 2));
  process.exitCode = 1;
} finally {
  await unloadModel();
  if (app) await app.close().catch(() => undefined);
}
