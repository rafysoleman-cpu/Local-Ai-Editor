/**
 * Stages a runnable copy of the app outside the workspace.
 *
 * Chromium refuses to start when the working directory is inside this
 * particular sandboxed Documents workspace, so GUI verification runs from
 * C:\Users\Public\laie-verify. The build itself still lives in the repository.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const verifyRoot = 'C:/Users/Public/laie-verify';
const appDir = path.join(verifyRoot, 'app');
const electronDir = 'C:/Users/Public/laie-electron';

async function copyIfExists(from, to) {
  try {
    await fs.cp(from, to, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export async function stageApp(options = {}) {
  const freshData = options.freshData !== false;
  await fs.mkdir(verifyRoot, { recursive: true });
  await fs.rm(appDir, { recursive: true, force: true });
  await fs.mkdir(appDir, { recursive: true });
  await copyIfExists(path.join(root, 'dist'), path.join(appDir, 'dist'));

  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  await fs.writeFile(
    path.join(appDir, 'package.json'),
    `${JSON.stringify(
      {
        name: pkg.name,
        productName: pkg.productName,
        version: pkg.version,
        main: 'dist/main/main.js',
        description: pkg.description,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  // Mirror the Electron runtime into a clean public path.
  await fs.rm(electronDir, { recursive: true, force: true });
  await copyIfExists(path.join(root, 'node_modules/electron/dist'), electronDir);

  const userDataDir = path.join(verifyRoot, 'userData');
  const dataDir = path.join(verifyRoot, 'data');
  if (freshData) {
    await fs.rm(userDataDir, { recursive: true, force: true });
    await fs.rm(dataDir, { recursive: true, force: true });
  }
  await fs.mkdir(userDataDir, { recursive: true });
  await fs.mkdir(path.join(dataDir, 'app'), { recursive: true });
  await fs.writeFile(
    path.join(userDataDir, 'storage-location.json'),
    `${JSON.stringify(
      { dataDirectory: dataDir, updatedAt: new Date().toISOString() },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const settingsPath = path.join(dataDir, 'app', 'settings.json');
  if (freshData) {
    await fs.writeFile(
      settingsPath,
      `${JSON.stringify(
        {
          defaultModel: 'gemma4:12b',
          ollamaBaseUrl: 'http://127.0.0.1:11434',
          theme: 'dark',
          generation: { temperature: 0, topP: 0.9, numCtx: 16384 },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }

  const projectA = path.join(verifyRoot, 'project-a');
  const projectB = path.join(verifyRoot, 'project-b');
  if (freshData) {
    for (const dir of [projectA, projectB]) {
      await fs.rm(dir, { recursive: true, force: true });
      await fs.mkdir(path.join(dir, 'src'), { recursive: true });
    }
    await fs.writeFile(
      path.join(projectA, 'README.md'),
      '# Project A\n\nIsolation marker: PROJECT_A_SECRET_MARKER_9f3a\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(projectA, 'src', 'hello.ts'),
      'export function hello(name: string): string {\n  return `Hello, ${name}!`;\n}\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(projectA, 'src', 'util.ts'),
      'export const answer = 41;\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(projectB, 'notes.md'),
      '# Project B\n\nIsolation marker: PROJECT_B_SECRET_MARKER_4c1d\n',
      'utf8',
    );
  }

  return { appDir, electronDir, userDataDir, dataDir, projectA, projectB };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const staged = await stageApp();
  console.log(JSON.stringify(staged, null, 2));
}
