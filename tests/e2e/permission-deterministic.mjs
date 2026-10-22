/**
 * Deterministic permission E2E. A test-mode hook seeds an approved plan, then the
 * real model runs a protected command through the real approval dialog.
 * Verifies Allow Once (not persisted), Always Allow (persisted + reused).
 */
import { _electron as electron } from 'playwright';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { stageApp } from '../../scripts/stage-app.mjs';

const outputDir = path.join(process.cwd(), 'test-results');
await fs.mkdir(outputDir, { recursive: true });
const staged = await stageApp({ freshData: true });

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CHROME_CRASHPAD_PIPE_NAME;
env.ELECTRON_ENABLE_LOGGING = '1';
env.LAIE_DISABLE_GPU = '1';
env.LAIE_TEST_MODE = '1';
env.LAIE_USER_DATA_DIR = staged.userDataDir;
env.LAIE_DATA_DIR = staged.dataDir;

const app = await electron.launch({
  executablePath: path.join(staged.electronDir, 'electron.exe'),
  args: [staged.appDir],
  cwd: staged.appDir,
  env,
  timeout: 60000,
});
app.process().stdout?.on('data', (chunk) => {
  const text = chunk.toString();
  if (text.includes('Agent run') || text.includes('before-quit') || text.includes('close event')) {
    process.stdout.write(`[main] ${text}`);
  }
});
app.process().stderr?.on('data', (chunk) => {
  const text = chunk.toString();
  if (!text.includes('Debugger')) process.stderr.write(`[main:err] ${text}`);
});

const page = await app.firstWindow({ timeout: 60000 });
const errors = [];
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
page.on('pageerror', (error) => errors.push(error.message));
page.on('close', () => console.log('[page] CLOSED'));

const prompt = 'Call run_command exactly once with this command: node -e "console.log(41+1)"\nThen reply DONE.';

async function readCalls(projectId) {
  return page.evaluate(async (id) => {
    const chats = await window.desktop.chats.list(id);
    const all = [];
    for (const chat of chats) all.push(...(await window.desktop.chats.messages(id, chat.id)));
    return all.flatMap((message) => message.toolCalls).filter((call) => call.name === 'run_command');
  }, projectId);
}

async function poll(check, label, timeout = 180000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (page.isClosed()) throw new Error(`page closed while waiting for ${label}`);
    const value = await check();
    if (value) return value;
    await page.waitForTimeout(600);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function waitForDialog(dialog, timeout, label) {
  try {
    await dialog.waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}

async function waitForSuccess(count, timeout = 180000) {
  return poll(async () => {
    const calls = await readCalls(await projectId());
    return calls.filter((call) => call.status === 'success').length >= count;
  }, `successful command #${count}`, timeout);
}

let cachedProjectId = null;
async function projectId() {
  if (cachedProjectId) return cachedProjectId;
  cachedProjectId = await page.evaluate(async () => (await window.desktop.projects.list())[0].id);
  return cachedProjectId;
}

try {
  await page.waitForSelector('.app', { timeout: 60000 });
  await page.waitForSelector('.dashboard', { timeout: 30000 });
  await page.locator('.dash-actions').getByRole('button', { name: /add existing folder/i }).click();
  await page.fill('#project-name', 'Permission Project');
  await page.fill('#project-path', staged.projectA);
  await page.getByRole('button', { name: /^add project$/i }).click();
  await page.waitForSelector('.workspace', { timeout: 30000 });
  const pid = await projectId();

  await page.locator('.section-header').filter({ hasText: 'Chats' }).getByTitle(/new chat/i).click();
  await page.waitForSelector('.composer textarea', { timeout: 20000 });
  const chatId = await poll(async () => {
    const chats = await page.evaluate((id) => window.desktop.chats.list(id), pid);
    return chats[0]?.id ?? null;
  }, 'chat creation');

  await page.evaluate(
    (input) => window.desktop.dev.seedApprovedPlan(input),
    { projectId: pid, chatId, title: 'Permission test plan', taskTitle: 'Run the protected command' },
  );
  await page.waitForTimeout(500);

  const dialog = page.locator('.modal', { hasText: 'Permission required' });

  // --- Allow Once -----------------------------------------------------------
  await page.fill('.composer textarea', prompt);
  await page.keyboard.press('Enter');
  if (!(await waitForDialog(dialog, 180000, 'allow once'))) {
    throw new Error('Permission dialog did not appear for a protected command');
  }
  await page.screenshot({ path: path.join(outputDir, 'permission-dialog.png') });
  console.log('[dialog]', (await dialog.innerText()).replace(/\n/g, ' | '));
  await dialog.getByRole('button', { name: /allow once/i }).click();
  await waitForSuccess(1);
  let permissions = await page.evaluate((id) => window.desktop.permissions.list(id), pid);
  let calls = await readCalls(pid);
  console.log(
    '[allow-once]',
    JSON.stringify({ permissions: permissions.length, calls: calls.map((call) => ({ status: call.status, permission: call.permission, result: call.result })) }),
  );
  if (permissions.length !== 0) throw new Error('Allow Once persisted a permission');
  if (!calls.some((call) => call.result?.includes('42'))) {
    throw new Error('Approved command did not return the expected output');
  }
  await page.screenshot({ path: path.join(outputDir, 'permission-allow-once.png') });

  // --- Always Allow ---------------------------------------------------------
  await page.fill('.composer textarea', prompt);
  await page.keyboard.press('Enter');
  if (!(await waitForDialog(dialog, 180000, 'always allow'))) {
    throw new Error('Permission dialog did not appear the second time');
  }
  await dialog.getByRole('button', { name: /always allow/i }).click();
  await waitForSuccess(2);
  permissions = await page.evaluate((id) => window.desktop.permissions.list(id), pid);
  console.log('[always-allow]', JSON.stringify(permissions.map((entry) => entry.actionKey)));
  if (permissions.length === 0) throw new Error('Always Allow did not persist a permission');

  // --- Stored permission is reused -----------------------------------------
  await page.fill('.composer textarea', prompt);
  await page.keyboard.press('Enter');
  const promptedAgain = await waitForDialog(dialog, 9000, 'stored permission prompt');
  if (promptedAgain) throw new Error('Stored permission did not suppress the prompt');
  await waitForSuccess(3);
  permissions = await page.evaluate((id) => window.desktop.permissions.list(id), pid);
  if (permissions.length !== 1) throw new Error('Unexpected permission count after reuse');
  await page.screenshot({ path: path.join(outputDir, 'permission-stored.png') });

  calls = await readCalls(pid);
  console.log(
    JSON.stringify(
      {
        ok: true,
        permissions: permissions.map((entry) => entry.actionKey),
        calls: calls.map((call) => ({ status: call.status, permission: call.permission })),
        errors,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error('[permission-e2e] FAILED', error);
  await page.screenshot({ path: path.join(outputDir, 'permission-failure.png') }).catch(() => undefined);
  console.log(JSON.stringify({ ok: false, error: error.message, errors }, null, 2));
  process.exitCode = 1;
} finally {
  try {
    await fetch('http://127.0.0.1:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gemma4:12b', keep_alive: 0 }),
    });
  } catch {
    /* ignore */
  }
  await app.close().catch(() => undefined);
}
