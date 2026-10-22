# Architecture

## Process model

```
┌──────────────────────────── Electron main ────────────────────────────┐
│  main.ts  ── WindowManager, Menu, app lifecycle, safe shutdown         │
│  ipc-handlers.ts ── one validated handler per IPC channel             │
│  Backend (backend.ts) ── composition root                              │
│    ├─ FileStorage / DataLocationManager / BackupService               │
│    ├─ ProjectService, ChatService, TaskService, MemoryService         │
│    ├─ WorkspaceService, CommandService, GitService, TerminalService   │
│    ├─ OllamaProvider, ContextBuilder, ContextCache                    │
│    ├─ ToolRegistry + ToolExecutor + PermissionService                 │
│    └─ AgentRuntime (the actual tool-calling loop)                     │
└───────────────────────────────┬────────────────────────────────────────┘
                                │ typed IPC (invoke + events), Zod-validated
┌───────────────────────────────┴────────────────────────────────────────┐
│ Preload (sandboxed) ── narrow `window.desktop` API, no generic IPC     │
├────────────────────────────────────────────────────────────────────────┤
│ Renderer (React + Zustand + Monaco + xterm.js)                        │
│  dashboard → workspace (sidebar | editor | chat) + terminal dock      │
└────────────────────────────────────────────────────────────────────────┘
```

The renderer has no Node.js access and cannot open arbitrary IPC channels. The
main process owns all filesystem, process and model operations.

## Startup sequence

1. `main.ts` sets the app name, optional portable profile/data overrides, installs
   security handlers and creates `WindowManager`.
2. `Backend.create()` resolves the active data directory, runs storage migrations,
   loads settings and constructs every service once.
3. IPC handlers are registered, the window is created, and the native menu is
   installed.
4. The renderer asks for `app:bootstrap`, then loads projects and the last open
   project/chat.

## Main modules

| Path | Responsibility |
| --- | --- |
| `electron/main/window-manager.ts` | Hardened `BrowserWindow`, navigation/window-open blocking, CSP header, permission denial, download blocking |
| `electron/main/ipc-handlers.ts` | All IPC channels; validates payloads; checks the sender is the app's main frame |
| `electron/preload/preload.ts` | Explicit `DesktopApi` implementation with event subscriptions |
| `src/backend/application/backend.ts` | Wiring, bootstrap, backup/restore/relocation, diagnostics, shutdown |
| `src/backend/storage/*` | Atomic writes, resilient reads, migrations, backups, relocation |
| `src/backend/projects/*` | Project lifecycle and all workspace path safety |
| `src/backend/agent/*` | Context/prompt building, tool registry, executor, limits, runtime |
| `src/backend/tools/*` | Built-in tools and custom declarative tools |
| `src/backend/permissions/*` | Policy engine, project-scoped storage, approval prompts |
| `src/backend/providers/*` | Provider interface and Ollama adapter |
| `src/backend/terminal/*` | Command process manager and interactive terminal sessions |

## Project isolation

A project ID is required on every project-scoped IPC call. Services re-verify
ownership rather than trusting the renderer:

- `ChatService.get(projectId, chatId)` checks the project index **and** the chat's
  own `projectId`.
- Messages are filtered by both IDs when read from JSONL.
- Plans/tasks must belong to the project index and carry the same `projectId`.
- Agent tools receive one validated `Project` and its workspace; there is no
  tool that takes a different project or an absolute path.
- Workspace paths are lexically contained and real-path checked; symlinks that
  escape the workspace are rejected.
- The application data directory can never be selected as a project workspace.

## Agent run data flow

```
user message → persist → build context (cached project block)
  → provider.chat(stream=true, tools)
  → parse tool calls → validate schema → check mode/permission
  → execute tool in backend → capture real result/diff
  → append tool message → repeat
  → final assistant message (tool records + context report) → persist
```

Every step emits an `AgentEvent` to the renderer (`run_started`, `status`,
`assistant_delta`, `tool_call_*`, `permission_request`, `plan_updated`,
`message_saved`, `run_finished`). The UI is a projection of those events plus
persisted state; it never fabricates tool output.

## Context and cache

The system prompt contains environment facts, hard rules, the mode instructions,
tool list, project instructions, concise memory, a partial file tree and the
current plan. Recent chat messages are added newest-first within a configurable
character budget. A five-minute in-memory cache stores the instruction/memory/tree
block and the file tree; fingerprints over content and depth-2 directory mtimes
invalidate it immediately when project data or files change. Cache diagnostics are
visible in Settings when enabled.

This cache reduces repeated scanning and prompt assembly. It does **not** reduce
the tokens the model itself processes, and it is not conversation memory.

## Error handling

- IPC errors are surfaced as readable messages in the UI (Electron's
  “Error invoking remote method” prefix is stripped).
- Corrupt storage files are quarantined, recovered from `.bak` where possible, and
  never silently deleted.
- Agent/tool failures are recorded as real tool-call records and returned to the
  model with an explicit “the action did NOT happen” message.
- Unknown/invalid tool calls are rejected before execution.
- Startup failures show a dialog and exit instead of running with broken storage.
