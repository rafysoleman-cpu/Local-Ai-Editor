# Troubleshooting

## The app does not start

- **“could not start” dialog**: read the message. Common causes are an unwritable
  data directory or data created by a newer storage format. Newer-format data is
  never modified; open it with the newer app or choose another data folder.
- **GPU/compositor crash on a VM**: set `LAIE_DISABLE_GPU=1` before launching.
- **Electron exits immediately in a restricted sandbox**: Chromium needs normal
  desktop process and file access. Run it from a normal user session. In this
  repository's development environment, launching from a sandboxed Documents
  folder crashed Chromium; the E2E stages the app under `C:\Users\Public`.

## Ollama is not connected

- Start Ollama (`ollama serve` or the desktop app) and confirm
  `http://127.0.0.1:11434/api/version` responds.
- Open the model selector and press **Refresh**.
- Check the base URL in Settings if you use a non-default port/host.
- The app never downloads a model on its own; use **Pull** or `ollama pull`.

## Model loads fail / CUDA errors

Symptoms in chat: `llama-server process has terminated`, `CUDA error`,
`shared object initialization failed`, HTTP 500 from Ollama.

- Restart Ollama. The GPU backend can enter a bad state after repeated rapid
  load/unload cycles.
- Reduce `num_ctx` in the model selector (e.g. 8192) or use a smaller model.
- On low-RAM machines, close other model clients and avoid running builds while a
  large model is loaded. Ollama keeps a model resident briefly after a request.
- CPU-only fallback: restart Ollama with a CPU-only configuration if your GPU
  driver is unstable.

## A model does not use tools

- Check its capability chips in the model selector. Models that do not report
  `tools` may answer in text instead of calling tools; the app warns instead of
  pretending a tool ran.
- Some models are inconsistent at planning/tool instructions. Try a stronger
  tool-calling model. Plan Mode still never mutates files, even if the model
  ignores instructions.
- If the model emits malformed tool arguments, the executor rejects the call with
  a validation error and returns it to the model.

## “A plan is awaiting approval” / Build Mode refuses to run

Approve the draft plan in the plan panel, or delete/reject it and create a new one.
Build Mode intentionally refuses unapproved plans. With no plan, Build Mode can
create a small internal plan (≤5 tasks); larger work needs approval.

## Permission prompt never appears / run seems stuck

- A prompt appears as a modal; if the window is unfocused it may be behind other
  windows.
- Unanswered prompts fail closed after the timeout (Settings → Agent).
- If a command is auto-approved, no prompt is shown. Check the tool card’s
  `permission` field (`auto`, `once`, `project`).
- Clean up stale stored permissions in **Tools & Permissions → Permissions**.

## Terminal command output is empty or quoting fails

The backend uses `cmd.exe /d /s /c` with verbatim arguments. If you entered a
command through the agent and its quotes were mangled by a shell layer, quote the
whole argument explicitly and re-run. Commands are user-controlled: prefer the
interactive terminal when experimenting.

## “Workspace folder does not exist”

The project folder was moved/deleted. Use **Project Settings → Locate again…** to
pick the new location. The app does not copy source code into its data folder.

## Data folder not writable / storage error

- Check the path in **Settings → Data & Storage**.
- Use **Open data folder** and inspect permissions.
- Make a backup before changing anything.
- Do not delete `manifest.json`; the app can rebuild the project index, but a
  broken manifest makes verification fail.

## Backups

- A backup is only listed as verified after manifest and project documents parse.
- Export copies to a folder you choose and verifies it; it does not include model
  files or source folders.
- Restoring creates a safety backup first. If restore reports a verification
  warning, inspect the data folder; the previous data is in the safety backup.

## Development server

- Port 5199 is fixed for Vite. If it is in use, stop the other process.
- `npm run dev` restarts Electron when main/preload changes; renderer edits
  hot-reload. If Electron is not found, run `npm install` (or
  `node node_modules/electron/install.js` when lifecycle scripts are blocked).
- Logs: `logs/app.log` in the data folder, plus main-process console output.

## Packaging

- `npm run package` creates an unpacked app under `release/`.
- `npm run dist` builds installers for the current OS. Cross-building other OSes
  from Windows is not configured.
- The app is unsigned; Windows SmartScreen may warn. Sign the installer in a real
  distribution setup.

## Where to look

- Application log: `<data folder>/logs/app.log`
- Tool execution history: `<data folder>/projects/project-*/logs/executions.jsonl`
- Project permissions: `<data folder>/projects/project-*/permissions.json`
- Storage pointer: Electron userData `storage-location.json`
