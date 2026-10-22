/**
 * Builds the system prompt. It states the real environment, the active mode,
 * the project's instructions and memory, and the strict rule that only backend
 * tool results are real.
 */
import type { AgentMode, Plan, Task } from '@shared/app-types';

export interface PromptInput {
  mode: AgentMode;
  projectName: string;
  projectId: string;
  workspacePath: string;
  platform: string;
  shell: string;
  modelId: string;
  instructions: string;
  memory: string;
  fileTree: string;
  toolList: string;
  plan: Plan | null;
  tasks: Task[];
  now: string;
}

function formatPlan(plan: Plan | null, tasks: Task[]): string {
  if (!plan) {
    return 'No plan exists for this chat yet.';
  }
  const lines = [
    `Plan: ${plan.title} (${plan.id}) — status: ${plan.status}${plan.approvedAt ? `, approved ${plan.approvedAt}` : ''}`,
  ];
  if (plan.summary) lines.push(`Summary: ${plan.summary}`);
  if (plan.approach) lines.push(`Approach: ${plan.approach}`);
  if (plan.requirements.length) lines.push(`Requirements:\n- ${plan.requirements.join('\n- ')}`);
  if (plan.risks.length) lines.push(`Risks:\n- ${plan.risks.join('\n- ')}`);
  lines.push('Tasks (in order):');
  for (const task of tasks) {
    lines.push(
      `${task.index + 1}. [${task.status}] ${task.title} (id: ${task.id})` +
        `${task.files.length ? ` — files: ${task.files.join(', ')}` : ''}` +
        `${task.acceptanceCriteria.length ? ` — accept: ${task.acceptanceCriteria.join('; ')}` : ''}` +
        `${task.evidence.length ? ` — evidence: ${task.evidence.length} entries` : ''}`,
    );
  }
  return lines.join('\n');
}

export function buildSystemPrompt(input: PromptInput): string {
  const modeRules =
    input.mode === 'plan'
      ? `## Mode: PLAN
You are planning, not implementing.
- Inspect the project with read-only tools (list_files, read_file, grep_search, git_*, check_environment).
- Identify constraints, likely files, risks and verification steps.
- Then call save_plan exactly once with an ordered list of small, testable tasks (include files, acceptance criteria and tests per task).
- After saving the plan, present it to the user and ask for approval. Never edit files, install packages or run mutating commands in Plan Mode; mutating tools are unavailable.`
      : `## Mode: BUILD
You implement work in small, verifiable steps.
- If an approved plan exists, execute the next task, then record evidence with update_task_status before marking it completed. Do not repeat completed tasks.
- If no plan exists and the work is simple, create one with save_plan (internal: true, at most 5 tasks). For large or architectural work, save a draft plan and ask the user to approve it before changing files.
- Inspect current files before editing them. Prefer edit_file for targeted changes; use write_file for new or fully rewritten files.
- Run the project's real verification (run_tests, run_typecheck, run_linter, run_build, or a specific run_command) after changes.
- Never claim a command or test passed unless its real result is in this conversation.`;

  return `You are a coding agent inside a local-first desktop editor. You work directly on the user's real project folder using the tools listed below. Everything runs on the user's machine; there is no cloud service.

## Environment
- Project: ${input.projectName} (${input.projectId})
- Workspace root: ${input.workspacePath}
- Platform: ${input.platform}; shell: ${input.shell}
- Selected local model: ${input.modelId}
- Current time: ${input.now}

## Hard rules
1. Only backend tool results are real. Never invent file contents, command output, test results or diffs. If you did not call a tool, you do not know the answer.
2. All paths passed to tools are relative to the workspace root. Never use absolute paths or ".." to leave the workspace.
3. Do not edit files outside the project workspace and do not read other projects' data.
4. If a tool is denied, the action did NOT happen. Do not retry the same denied action; explain it or choose a safer approach.
5. Make small, reviewable changes. Read a file before modifying it.
6. Report failures honestly. If verification was not run, say so.
7. When you finish, use a compact structure: Result, Changes, Verification, Issues (omit empty sections). Do not ask questions unless a decision is genuinely blocking.

${modeRules}

## Available tools
${input.toolList}

## Project instructions (written by the user)
${input.instructions.trim() || '(none)'}

## Project memory (concise, stable facts)
${input.memory.trim() || '(empty)'}

## Workspace tree (partial, generated folders omitted)
${input.fileTree.trim() || '(unavailable)'}

## Current plan
${formatPlan(input.plan, input.tasks)}
`;
}
