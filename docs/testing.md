# Testing

## Commands

```bash
npm run typecheck
npm test
npm run test:e2e
npm run test:e2e:permissions
npm run verify
```

`npm test` runs Vitest suites under `tests/unit`, `tests/integration` and
`tests/security`. `npm run test:e2e` runs the Playwright desktop test against a
staged production build. The permission E2E requires a local Ollama model and
sets `LAIE_TEST_MODE=1` to seed an approved plan deterministically.

## Automated coverage

### Unit — storage (`tests/unit/storage.test.ts`)

- atomic JSON write/read, no temp files left,
- corrupt primary recovered from `.bak`, bad file quarantined,
- fallback when no backup exists,
- malformed JSONL lines skipped, valid lines preserved,
- path traversal/absolute paths rejected,
- writes blocked while relocation pauses storage,
- v1 → current migration with a pre-migration backup,
- newer-format data refused without modification.

### Integration — projects/chats/memory (`tests/integration/projects-chats.test.ts`)

- projects, chats, messages, instructions and memory survive a backend restart,
- previous memory versions archived,
- chat-transcript-shaped memory rejected,
- cross-project chat/message access rejected,
- traversal and data-directory/workspace overlap rejected,
- dashboard removal archives project data and leaves source files intact.

### Integration — backups/relocation (`tests/integration/storage-operations.test.ts`)

- verified backup creation and listing,
- export to a folder and manifest presence,
- restore reverts memory/instructions and creates a safety backup,
- corrupt backup refused,
- data move verified, root switched, original retained,
- unsafe destinations rejected,
- manifest content recorded.

### Integration — agent runtime (`tests/integration/agent-runtime.test.ts`)

With a deterministic in-process provider:

- Plan Mode exposes no mutating tools, saves a draft plan,
- Build Mode refuses to run with a draft plan,
- Build gate blocks mutations until an internal/approved plan exists,
- task evidence and ordering enforced,
- cancellation saves an interrupted message and status,
- tool-call limit stops before the extra call,
- repeated failures stop the run,
- safe command auto-runs and its real output is captured,
- reads a real file and returns its content to the model,
- invalid tool arguments rejected before execution,
- invalid task transitions rejected.

### Security — permissions (`tests/security/permissions.test.ts`)

- Allow Once is single-use and not persisted,
- Always Allow is exact-action and project-scoped, reused without prompting,
- unanswered prompt fails closed,
- revocation works,
- cross-workspace reads via traversal rejected,
- catastrophic command blocked without prompting,
- denied command does not execute,
- quoted Windows commands execute correctly (`node -e "console.log(41+1)"` → `42`),
- file writes auto-approved but deletes always prompt.

## Results (last run in this environment)

| Check | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npm test` | 38 tests, 5 files — pass |
| `npm run build` | pass |
| `npm run test:e2e` | pass |
| `npm run test:e2e:permissions` | pass |

### Core desktop E2E (`tests/e2e/core-e2e.mjs`)

1. launch staged production app, dashboard rendered,
2. add existing folder as a project,
3. open `README.md` in Monaco, replace content, `Ctrl+S`, verify the file on
   disk,
4. `Ctrl+J`, run `echo core-e2e> terminal-core.txt` in the real terminal, verify
   the file,
5. send a chat message; local `gemma4:12b` replied “pong”,
6. create a verified backup in Settings,
7. close and relaunch; project/chat/messages restored.

Screenshots: `test-results/core-01-dashboard.png` … `core-06-restart.png`.

### Permission E2E (`tests/e2e/permission-deterministic.mjs`)

1. project + chat created through the UI,
2. test-only hook seeds an approved plan (model-driven plan creation is
   stochastic; the Plan UI itself was verified separately, see
   `permission-plan.png`),
3. request `run_command node -e "console.log(41+1)"`,
4. dialog shown; **Allow Once** → tool succeeds, output `42`, no stored
   permission,
5. same request → dialog again; **Always Allow** → one project-scoped record,
6. same request → no dialog, permission reused, output `42`.

Screenshots: `permission-dialog.png`, `permission-allow-once.png`,
`permission-stored.png`.

## Environment notes

- GUI tests were run on Windows 11 with Electron 44.7.0 and Ollama 0.40.8
  (`gemma4:12b`, `qwen3.8:27b`, both reporting tool support).
- Chromium refused to start when launched directly from the harness's sandboxed
  Documents workspace. The E2E therefore stages a copy of `dist/` and the Electron
  runtime under `C:\Users\Public\laie-verify` and launches there. This is an
  environment limitation, not an application requirement; normal installs run
  from Program Files or any normal folder.
- The machine has 16 GB RAM. Running a 12B model, Electron and a Vite build at the
  same time caused memory pressure and one model server crash. Tests unload the
  model after use and avoid concurrent builds; if Ollama returns
  `CUDA error: shared object initialization failed`, restart Ollama.
- Long-running Playwright E2E can be affected by the same memory pressure; the
  two suites above were run separately.

## Packaging

`electron-builder --dir` produced `release/win-unpacked` successfully. The packaged
executable was copied to a clean folder and started with `LAIE_SMOKE=1`; it loaded
the renderer and exited cleanly. Installer creation (`npm run dist`) and actual
install/uninstall flows were not executed.

## Not covered by automation

- installer/uninstaller execution,
- macOS/Linux GUI runs,
- multi-monitor/DPI edge cases,
- huge repositories and very large files,
- interactive TUI programs in the terminal (the terminal is not a PTY),
- vision/audio inputs and web lookup (not implemented),
- data-move and restore through the UI (backend integration tests cover the
  operations; backup creation was exercised through the UI).
