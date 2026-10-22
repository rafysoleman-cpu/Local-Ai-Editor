/**
 * Command risk classification.
 *
 * Path containment cannot sandbox a shell, so commands are classified and
 * gated by the permission service. Read-only inspection commands may run
 * automatically; anything that mutates the workspace, installs packages or
 * touches the system requires an explicit decision.
 */
import type { PermissionRisk } from '@shared/app-types';

export interface CommandAnalysis {
  command: string;
  risk: PermissionRisk;
  requiresApproval: boolean;
  /** True when the command is hard-blocked and cannot be approved from chat. */
  blocked: boolean;
  reason: string;
  actionKey: string;
}

const SAFE_COMMANDS = new Map<string, string[]>([
  ['pwd', []],
  ['ls', []],
  ['dir', []],
  ['get-childitem', []],
  ['gci', []],
  ['type', []],
  ['cat', []],
  ['head', []],
  ['tail', []],
  ['wc', []],
  ['echo', []],
  ['where', []],
  ['which', []],
  ['whoami', []],
  ['hostname', []],
  ['node', ['--version', '-v']],
  ['npm', ['--version', '-v', 'ls', 'list']],
  ['git', ['status', 'diff', 'log', 'show', 'branch', 'remote', 'rev-parse', '--version', 'blame']],
  ['tsc', ['--version', '--noEmit']],
  ['python', ['--version']],
  ['python3', ['--version']],
]);

const HIGH_RISK_COMMANDS = new Set([
  'rm',
  'del',
  'erase',
  'rmdir',
  'rd',
  'mv',
  'move',
  'ren',
  'rename',
  'chmod',
  'chown',
  'chgrp',
  'sudo',
  'runas',
  'takeown',
  'icacls',
  'cacls',
  'reg',
  'regedit',
  'sc',
  'net',
  'taskkill',
  'kill',
  'pkill',
  'killall',
  'npm',
  'pnpm',
  'yarn',
  'pip',
  'pip3',
  'python',
  'python3',
  'curl',
  'wget',
  'invoke-webrequest',
  'iwr',
  'invoke-restmethod',
  'irm',
  'ssh',
  'scp',
  'docker',
  'kubectl',
  'aws',
  'az',
  'gcloud',
  'npx',
  'bunx',
  'nvm',
  'winget',
  'choco',
  'apt',
  'apt-get',
  'brew',
  'yum',
  'dnf',
]);

const HARD_BLOCKED: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /^format(\s|$)/i, reason: 'Formatting a disk is never allowed from the agent.' },
  { pattern: /^diskpart(\s|$)/i, reason: 'Disk partitioning is never allowed from the agent.' },
  { pattern: /^(shutdown|restart-computer|stop-computer)(\s|$)/i, reason: 'Powering off the machine is not allowed.' },
  { pattern: /^(bcdedit|bootrec)(\s|$)/i, reason: 'Editing boot configuration is not allowed.' },
  { pattern: /rm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\s+(\/|~|\*|c:\\|d:\\|\$home)/i, reason: 'Recursive deletion of a drive or home directory is not allowed.' },
  { pattern: /del\s+\/[a-z]\s+\/[a-z]\s+[a-z]:\\(\s|$)/i, reason: 'Recursive deletion of a drive root is not allowed.' },
  { pattern: /rd\s+\/s\s+\/q\s+[a-z]:\\(\s|$)/i, reason: 'Recursive deletion of a drive root is not allowed.' },
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\};:/, reason: 'Fork bomb pattern detected.' },
];

const PIPE_TO_SHELL = /\|\s*(sh|bash|zsh|powershell|pwsh|cmd|iex|invoke-expression)\b/i;

export function normalizeCommand(command: string): string {
  return command.replace(/\s+/g, ' ').trim();
}

export function commandActionKey(command: string): string {
  return `run_command:${normalizeCommand(command).slice(0, 900)}`;
}

function firstToken(command: string): { name: string; rest: string[] } {
  const tokens = normalizeCommand(command).split(' ').filter(Boolean);
  const raw = tokens[0] ?? '';
  const name = raw
    .replace(/^["']|["']$/g, '')
    .split(/[\\/]/)
    .pop()!
    .replace(/\.(exe|cmd|bat|ps1)$/i, '')
    .toLowerCase();
  return { name, rest: tokens.slice(1) };
}

export function analyzeCommand(command: string): CommandAnalysis {
  const normalized = normalizeCommand(command);
  const actionKey = commandActionKey(normalized);
  const { name, rest } = firstToken(normalized);

  for (const rule of HARD_BLOCKED) {
    if (rule.pattern.test(normalized)) {
      return {
        command: normalized,
        risk: 'high',
        requiresApproval: true,
        blocked: true,
        reason: rule.reason,
        actionKey,
      };
    }
  }

  if (PIPE_TO_SHELL.test(normalized)) {
    return {
      command: normalized,
      risk: 'high',
      requiresApproval: true,
      blocked: false,
      reason: 'Piping downloaded or generated content into a shell can execute arbitrary code.',
      actionKey,
    };
  }

  if (/\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|restore\s+)/i.test(normalized)) {
    return {
      command: normalized,
      risk: 'high',
      requiresApproval: true,
      blocked: false,
      reason: 'This Git command can discard uncommitted user changes.',
      actionKey,
    };
  }

  if (/\bgit\s+push\b.*(--force|-f)\b/i.test(normalized)) {
    return {
      command: normalized,
      risk: 'high',
      requiresApproval: true,
      blocked: false,
      reason: 'Force-pushing rewrites remote history.',
      actionKey,
    };
  }

  const safeVariants = SAFE_COMMANDS.get(name);
  if (safeVariants) {
    const allowed =
      safeVariants.length === 0 ||
      safeVariants.some((variant) => rest.join(' ').toLowerCase().startsWith(variant.toLowerCase()));
    if (allowed && !/[>|]/.test(normalized)) {
      return {
        command: normalized,
        risk: 'low',
        requiresApproval: false,
        blocked: false,
        reason: 'Read-only inspection command.',
        actionKey,
      };
    }
  }

  const isInstall = /^(npm|pnpm|yarn|npx|bun|bunx|pip|pip3)\s+(i|install|add|ci|create|dlx)\b/i.test(normalized);
  const isTestOrBuild = /^(npm|pnpm|yarn|bun)\s+(run\s+)?(test|build|lint|typecheck|check|verify|dev|start)\b/i.test(
    normalized,
  );
  const isProjectScript = /^(node|tsx|ts-node|python|python3|pytest|vitest|jest|tsc|eslint|prettier)\b/i.test(normalized);

  if (HIGH_RISK_COMMANDS.has(name)) {
    const risk: PermissionRisk = isInstall ? 'high' : 'medium';
    return {
      command: normalized,
      risk,
      requiresApproval: true,
      blocked: false,
      reason: isInstall
        ? 'Installing packages downloads and runs third-party code.'
        : isTestOrBuild || isProjectScript
          ? 'Runs project code; requires approval under the current policy.'
          : `The "${name}" command can modify the system or workspace.`,
      actionKey,
    };
  }

  return {
    command: normalized,
    risk: isTestOrBuild || isProjectScript ? 'medium' : 'medium',
    requiresApproval: true,
    blocked: false,
    reason: 'Unrecognized command; approval is required.',
    actionKey,
  };
}
