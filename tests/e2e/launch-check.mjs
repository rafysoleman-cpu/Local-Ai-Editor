/**
 * Launch check for the staged build: verifies the real Electron app renders the
 * dashboard and that the preload API responds, then saves a screenshot.
 */
import { _electron as electron } from 'playwright';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { stageApp } from '../../scripts/stage-app.mjs';

const staged = await stageApp();
const outputDir = path.join(process.cwd(), 'test-results');
await fs.mkdir(outputDir, { recursive: true });

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CHROME_CRASHPAD_PIPE_NAME;

env.ELECTRON_ENABLE_LOGGING = '1';
env.LAIE_USER_DATA_DIR = staged.userDataDir;
env.LAIE_DATA_DIR = staged.dataDir;

const errors = [];
const app = await electron.launch({
  executablePath: path.join(staged.electronDir, 'electron.exe'),
  args: [staged.appDir],
  cwd: staged.appDir,
  env,
  timeout: 60000,
});

app.process().stdout?.on('data', (chunk) => process.stdout.write(`[main] ${chunk}`));
app.process().stderr?.on('data', (chunk) => process.stderr.write(`[main:err] ${chunk}`));

try {
  const page = await app.firstWindow({ timeout: 60000 });
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
    console.log(`[renderer:${message.type()}] ${message.text()}`);
  });
  page.on('pageerror', (error) => {
    errors.push(error.message);
    console.log(`[pageerror] ${error.message}`);
  });

  await page.waitForSelector('.app', { timeout: 60000 });
  await page.waitForSelector('.dashboard', { timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(outputDir, 'staged-dashboard.png') });

  const bootstrap = await page.evaluate(() => window.desktop.app.bootstrap());
  const dataInfo = await page.evaluate(() => window.desktop.app.dataInfo());
  const provider = await page.evaluate(() => window.desktop.provider.status(true));
  const title = await page.title();

  console.log(
    JSON.stringify(
      {
        title,
        dataDirectory: bootstrap.dataDirectory,
        settingsDefaultModel: bootstrap.settings.defaultModel,
        dataInfo: { size: dataInfo.sizeBytes, backups: dataInfo.backupCount },
        provider: {
          connected: provider.connected,
          version: provider.version,
          models: provider.models.map((model) => ({ id: model.id, tools: model.supportsTools })),
        },
        errors,
      },
      null,
      2,
    ),
  );
  if (errors.length > 0) process.exitCode = 1;
} finally {
  await app.close();
}
