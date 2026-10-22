# Permissions

Permissions answer one question: *may this specific backend action run?* They do
not replace path validation or mode restrictions; every check runs independently.

## Categories

| Category | Examples | Default behavior |
| --- | --- | --- |
| `read` | list/read/grep/git status | auto if “auto-approve read-only” is on |
| `write` | create/write/edit/rename | auto if “auto-approve file writes” is on (deletes excluded) |
| `delete` | delete_file | always asks; “Always Allow” is not offered |
| `execute` | run_command, tests/build/lint/typecheck, diagnostics | asks unless a stored permission or safe-command policy applies |
| `git` | read-only git tools | auto if read-only policy is on |
| `memory` | memory/plan/task updates | auto (previous memory version archived) |
| `custom` | user-defined command tools | always asks |

## Policy order

1. A matching, unexpired project permission → allow.
2. A low-risk, read-only command with read-only auto-approval on → allow.
3. Read-only/git with read-only auto-approval on → allow.
4. Memory updates → allow.
5. File writes with write auto-approval on and risk not `high` → allow.
6. Everything else → prompt the user; unanswered prompts fail closed (deny).

Hard-blocked commands are refused before a prompt is shown and cannot be approved
from chat: disk formatting/partitioning, shutdown/restart, boot configuration,
drive-root recursive deletion, and fork bombs.

## Allow Once vs Always Allow

- **Allow Once** grants the current tool call only. Nothing is persisted, and the
  same action asks again next time.
- **Always Allow** persists a record in `projects/project-<id>/permissions.json`:
  - project id,
  - category,
  - tool name,
  - action key,
  - label,
  - creation timestamp,
  - optional expiry,
  - policy version.

The action key is intentionally narrow:

- commands: `run_command:<exact command>`
- scripts: `script:<kind>:<script>`
- file writes: `write_dir:<workspace-relative directory>`
- typecheck: `run_diagnostics:typecheck`
- custom tools: no “always” key (always prompt)

Permissions are **project-scoped**. Approving a command in Project A never
authorizes it in Project B, even if both projects share a filesystem path.

Review and revoke records in **Tools & Permissions → Permissions**. Revocation
takes effect on the next tool call.

## Denials

A denial returns a structured tool result:

```
PERMISSION DENIED for tool "run_command": You denied this action.
The action was NOT executed. Do not retry the same action; explain the situation
to the user or choose a safe alternative.
```

The UI records the tool call as `denied` (red), not as a success.

## Residual risk

Path checks cannot sandbox a shell. An approved command runs with your user
account's privileges and can reach outside the workspace. Read the exact command
and working directory in the prompt before approving. Prefer "Allow Once" for
anything destructive, and review stored permissions periodically.

The app blocks a small set of catastrophic commands, but this is defense in depth,
not a security boundary. Use OS-level isolation if you need stronger guarantees.
