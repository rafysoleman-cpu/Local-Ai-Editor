# Storage, backups and relocation

The first version uses human-readable files, not a database server. The storage
interface (`Storage`) is small so SQLite can replace it later without touching the
UI or agent runtime.

## Location

The active data directory is stored in `storage-location.json` inside Electron's
userData folder. Default: `<Documents>/LocalAIEditorData`.

Resolution order:

1. `LAIE_DATA_DIR` environment override (portable installs / automated tests).
2. The pointer file, if the directory exists.
3. The default Documents location.

If a pointer is missing/unreadable, the file is preserved with an
`.invalid-<timestamp>` suffix and the fallback is used with a visible warning. Data
is never deleted because a path moved.

## Layout

```
manifest.json                 summary + format version + project index
app/settings.json             UI, model, context, limits, layout
app/storage-version.json      format version + migration history
app/custom-tools.json         declarative custom tool definitions
projects/project-<id>/project.json
                     /instructions.md
                     /memory.md
                     /memory-history/memory-<timestamp>.md
                     /chats/chat-<id>/chat.json
                                     /messages.jsonl
                                     /session.json
                     /plans/plan-<id>.json
                     /tasks/task-<id>.json
                     /permissions.json
                     /logs/executions.jsonl
backups/                      verified snapshots + archived removed projects
logs/app.log                  structured JSONL application log
cache/                        disposable (excluded from backups/moves)
```

## Reliability

- **Atomic writes**: data goes to a temporary sibling, is `fsync`ed, then renamed
  over the target. A crash cannot leave half-written JSON.
- **Previous-version backups**: critical JSON gets a `.bak` sibling before being
  replaced.
- **Resilient reads**: primary → quarantine corrupt file (`.corrupt-<timestamp>`
  plus reason) → try `.bak` → fallback. Warnings are logged and shown in the UI.
- **Validation**: Zod schemas validate every persisted document and IPC payload.
- **JSONL**: malformed lines are skipped with a warning; valid lines are kept.
- **Versioned migrations**: pre-migration snapshots are written under
  `backups/pre-migration-*`; data from a newer format is refused rather than
  modified.
- **Serialized writes**: writes to the same path are queued; relocation pauses new
  writes and waits for in-flight writes to finish.

## Backups

`BackupService` copies `manifest.json`, `app/`, `projects/` and `logs/`, skipping
`cache/`, `backups/`, `.bak` and quarantined files. A backup is only reported after
verification:

- `manifest.json` exists and parses,
- every `projects/*/project.json` parses,
- file count/size are recorded,
- `backup.json` metadata is written.

`Settings → Data & Storage` can create a backup, export one to any folder, list
existing backups, and restore one. Restore:

1. verifies the backup,
2. creates an automatic safety backup of the current data,
3. pauses writes,
4. swaps `app/`, `projects/` and `logs/` via a staging directory,
5. re-runs migrations and reloads settings/custom tools,
6. verifies the restored data and reports any problem.

## Moving application data

`Move application data`:

1. validates the destination (absolute, not the current directory, not nested
   inside it, not a parent of it, empty, writable),
2. checks free space when available,
3. pauses writes and waits for idle,
4. copies everything except `cache/`,
5. verifies manifest/project counts and file counts,
6. writes the new pointer and switches the active root,
7. leaves the original directory untouched.

Project source folders and Ollama model files are **not** moved. After switching
machines, reopen a project and use **Project Settings → Locate again…** if its
workspace path is missing.

Backups do not contain local model weights or your source folders. Copy those
separately if you need a complete machine migration.

## What is not persisted

Cache entries (five-minute TTL), running processes, terminal sessions and
in-flight model requests. Chat messages are persisted as they complete; a
cancelled run stores an interrupted assistant message with the text received so
far.
