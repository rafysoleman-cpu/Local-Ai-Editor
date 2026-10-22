/**
 * Environment diagnostics: Node, npm, Git, Electron, Ollama, data folder and
 * build state. Prints a readable report and exits non-zero when a hard
 * requirement is missing.
 */
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const report = [];
let hardFailure = false;

function command(program, args) {
  try {
    const output = execFileSync(program, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return output.trim();
  } catch (error) {
    return `unavailable (${error.code ?? error.message})`;
  }
}

function line(label, value, ok = true) {
  report.push(`${ok ? '✓' : '✗'} ${label}: ${value}`);
  if (!ok) hardFailure = true;
}

line('Node.js', process.version, Number(process.versions.node.split('.')[0]) >= 20);
line('npm', command('npm', ['--version']));
line('Git', command('git', ['--version']));

try {
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  report.push(`• App version: ${pkg.version}`);
} catch {
  report.push('• App version: package.json not readable');
}

try {
  const electronVersion = (await fs.readFile(path.join(root, 'node_modules/electron/package.json'), 'utf8')).match(
    /"version"\s*:\s*"([^"]+)"/,
  )?.[1];
  line('Electron package', electronVersion ?? 'missing', Boolean(electronVersion));
} catch {
  line('Electron package', 'not installed (run npm install)', false);
}

try {
  const distMain = path.join(root, 'dist/main/main.js');
  await fs.access(distMain);
  report.push('• Build output: present (dist/)');
} catch {
  report.push('• Build output: missing (run npm run build)');
}

const ollamaUrl = process.env.OLLAMA_HOST?.startsWith('http')
  ? process.env.OLLAMA_HOST
  : 'http://127.0.0.1:11434';
try {
  const response = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(4000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  const models = (body.models ?? []).map((model) => `${model.name}${(model.capabilities ?? []).includes('tools') ? ' [tools]' : ''}`);
  report.push(`• Ollama: connected at ${ollamaUrl}`);
  report.push(`• Installed models: ${models.length ? models.join(', ') : '(none — pull one in the app)'}`);
} catch (error) {
  report.push(`• Ollama: not reachable at ${ollamaUrl} (${error.message})`);
  report.push('  Start Ollama ("ollama serve" or the desktop app), then pull a model.');
}

console.log('\nLocal AI Editor — environment check\n');
for (const entry of report) console.log(entry);
console.log('');
if (hardFailure) {
  console.error('One or more required tools are missing.');
  process.exit(1);
}
console.log('Environment is ready for development.');
