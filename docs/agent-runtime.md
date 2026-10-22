# Agent runtime

The agent is a real loop, not prompt-driven tool simulation.

## Modes

**Plan** is read-only:

- Only read-only tools and `save_plan` are exposed; mutating tools are filtered
  from the tool list and rejected again by the executor.
- The model inspects the project, then calls `save_plan` with ordered tasks
  (files, acceptance criteria, tests, risk).
- The plan is stored as a draft and shown for approval. Plan Mode never writes
  project files, installs packages or runs mutating commands.

**Build** implements work:

- Requires an approved (or internal) plan; a draft plan makes `start()` fail with
  a clear message.
- With no plan, mutating tools are blocked until the model creates a small
  internal plan (`save_plan { internal: true }`, max 5 tasks). Plans larger than
  that must be approved by the user.
- Executes tasks in order and calls `update_task_status`. A task cannot move to
  `completed` without evidence, and cannot be completed before earlier tasks.
- Runs real verification commands and reports their actual results.

## Loop

```
limits.check()
build context (cache-aware)
provider.chat(messages, tools, stream)
for each tool call:
  validate arguments against the tool's Zod schema
  check tool is registered, enabled, allowed in this mode
  check Build-Mode plan gate
  ask permission or auto-approve
  execute with timeout/abort signal
  record result/diff/error
  append a `tool` message with the real result
repeat until no tool calls, cancellation, or a limit
persist assistant message (content, tool records, context report)
```

Every tool call has a unique id, status, arguments, timestamps, duration,
permission source, risk, human summary, structured details and optional diff.
The model only ever sees backend-captured results.

## Context

- System rules and environment (platform, shell, paths, model, time).
- The mode-specific instructions.
- Tool list available in this mode.
- Project instructions, concise memory and a partial file tree.
- Recent messages from this chat only (never other chats/projects).
- The current approved plan and task statuses.
- The current request.

A configurable character budget is enforced. Old messages are dropped first; the
project block is scaled down if needed; the newest user request is preserved and
truncation is reported. Tool results are capped per message and the conversation
is compacted when it grows beyond the budget. The five-minute cache stores only
the instruction/memory/tree block and file tree, keyed by content and directory
fingerprints.

## Limits

Configurable in Settings:

| Limit | Default |
| --- | --- |
| max tool calls per run | 16 |
| max model iterations | 8 |
| max repeated identical failures | 3 |
| max command duration | 180 s |
| max command output | 60,000 chars |
| max run duration | 15 min |
| max model retries | 2 |

Reaching a limit stops the run with an explicit reason in the assistant message.
Cancellation stops new tool calls, aborts the provider request and running child
processes, preserves completed work, and saves an interrupted message.

## Concurrency

A workspace-level lock allows one run per project at a time. A conflicting run
fails immediately with the holder's start time and chat id. Chats are additionally
protected against two simultaneous runs.

## Provider (Ollama)

- `/api/version`, `/api/tags` for connection and real model discovery.
- `/api/chat` with NDJSON streaming, tool schemas and real tool calls.
- `/api/pull` with progress and cancellation.
- Model capabilities (including `tools`) come from the provider; a missing
  capability produces a visible warning instead of a silent assumption.
- Selected models are never silently replaced. If the configured model
  disappeared, the run fails with instructions to choose another.
- Generation options: temperature, top-p, `num_ctx`.

## Command execution (Windows)

`cmd.exe /d /s /c <command>` is spawned with `windowsVerbatimArguments: true` so
quotes reach the command intact (needed for `node -e "..."`, paths with spaces,
etc.). Commands run through the backend process manager with a parsed command
policy, timeout, output cap, process-tree termination and cancellation. The
interactive terminal uses the same process manager; the renderer only performs
line editing and display.

Process stdio prefers pipes for true streaming. If the environment forbids pipe
creation, the manager transparently falls back to file-descriptor stdio and tails
the output files (reported as `stdioMode: file`).

## Honesty rules encoded in the prompt

- Only backend tool results are real.
- Never claim a test or command passed unless its result is in the conversation.
- A denied tool did not happen; do not retry it blindly.
- All paths are workspace-relative.
- State failures and unrun verification plainly.

The final message also appends backend facts: plan progress, next task, and run
status when stopped/cancelled/failed.
