# One editor buffer per file

Status: proposed. This replaces the open drafts #30714, #30681 and #30417, and builds on the merged guarded write (#30605).

## Problem

Orca keeps a file's text, and its "last known disk version", in many separate places:

- fields stored per tab in the store (unsaved draft, dirty flag, disk signature, changed-on-disk mark, autosave pauses)
- each panel's `fileContents` and `diffContents` caches
- `editorDrafts`
- the shared text model
- the rich markdown, notebook and CSV views
- combined-diff sections
- the mobile bridge

About twenty review rounds across three draft PRs kept finding one kind of bug: a save or a check took the text from one copy and the disk version from another. Four examples:

1. **One workspace overwrites another.** Two workspaces open the same file. They share the text model but each keeps its own dirty flag. Typing in A changes the text in B, but B still thinks it is clean, so B autosaves or restores old text.
2. **An old cache wins.** A panel that opens after a save or reload still holds the disk text from before it. It pushes that old text into the shared model.
3. **Clean tab, leftover draft.** After you undo back to the saved text, the dirty check says clean. That check compares content, and for markdown it ignores trailing whitespace. A draft is still left in the store, and hot exit, the preview and mobile keep using it.
4. **Banner actions race.** Reload, its Undo toast and a disk read still in progress each write the draft, the disk version and the text separately. If you type in between, the results get mixed.

## Goals and non-goals

**Goals:**

- One record per physical file holds its text, dirty state, disk version, conflict state and save queue.
- Every view of the file is a projection of that record.
- Dirty state comes from edit version numbers, not from comparing content.
- Reloading from disk can be undone.
- Every save, from any view, is checked against the disk when it is written.

**Non-goals:**

- Merging edits from several writers.
- A three-way merge screen.
- Host-side changes beyond the optional `currentSignature` field on a refused write.
- Treating aliased paths to one file as a single document (see open questions).

## Model

**Key**: the execution host (local, a WSL distro, an SSH connection or a runtime environment) plus the normalized path. The workspace is never part of the key. The key is the text model's URI. For hosts that aren't local, the URI starts with an `/.orca-owner/<hash>/` folder, which keeps the real file name last so the language service still recognizes the file type. The key stays in the renderer and is never sent over the wire.

| Field | Owns |
| --- | --- |
| `model` | The text model, the only editable copy of the text. |
| `savedVersion` | The model's version when its text last matched disk. Dirty means `model.version !== savedVersion`. |
| `baseline` | The disk signature (hash and stat) that `savedVersion` matches. |
| `conflict` | `{ observed, consent? }`: the disk version an outside change produced (or "deleted"), and the version the user agreed to overwrite. |
| `autosavePause` | Why autosave is paused (restore check, disk check, undo past a reload), with a generation number so a save clears only the pause it saw. |
| `saveQueue` | Runs this file's saves one at a time, with a single autosave timer. |
| `views` | The tabs and panes showing the file. Each keeps only its own scroll position, selection and mode. |

The record lives in one renderer store slice. Today's per-tab fields become values read from it.

**Lifecycles:**

- **Open**: the first view creates the record, setting the text, `savedVersion` and `baseline` in one step. Views opened later attach to it and see the current unsaved edits.
- **Close**: the view detaches. Only closing the last view asks to save. The model is then kept for undo after closing, as it is today.
- **External change**: the file watcher, or a refused save, sets `conflict.observed`. A clean record reloads. A dirty record shows the banner on every view and pauses autosave.
- **Reload**: note `model.version`, then read the file. When the read returns, apply it only if the version and the watcher's change counter are both unchanged. Apply it as one undoable, programmatic edit, then update `savedVersion` and `baseline` and clear `conflict`. Undoing past the reload pauses autosave until the user saves explicitly or redoes.
- **Keep My Edits**: sets `conflict.consent` to `conflict.observed`, clears the banner and resumes autosave, without reading the disk.
- **Save**:
  - Capture `{text, version, baseline, consent}` in one tick, then do a guarded write that expects `consent ?? baseline`.
  - On success, mark the file clean only if its version hasn't changed since the capture. Otherwise only move `baseline` forward, and not if a reload changed it while the save was in flight.
  - A refusal sets `conflict.observed` to `currentSignature`.
  - Autosave never recreates a deleted file. An explicit save may.
- **Restore**: hot exit saves one draft per record, together with its baseline. A restored record starts dirty, with autosave paused until the disk has been checked. Sessions saved in the old per-tab format take the newest draft for each key.
- **Rename or move**: the record takes the new key, its views follow it, and a dirty file stays dirty.
- **Remote hosts**: the guarded write runs on the host that executes it: the main process for local and WSL, the runtime for SSH and remote hosts. It is pinned to the connection that answered the capability check. If contact with the host is lost, the record and its draft stay. Nothing is thrown away or reloaded until the host answers again.

## How each view maps onto the record

| View | Mapping |
| --- | --- |
| Code editor and split panes | Views attach to `model` directly. |
| Markdown source mode | Same as the code editor. |
| Markdown rich mode | A commit is a user edit on `model`, so it can be undone and marks the file dirty. The view re-renders when the model changes. |
| Notebook | Cell edits serialize into `model`, and the notebook re-parses when the version changes. |
| CSV | Cell edits become range edits on `model`. The byte index is keyed by version. |
| Single-file diff | The modified side is a view of `model`. The original side is read-only git content and isn't part of the record. |
| Combined diff | Each editable section attaches to its file's record and saves through it. The per-section overwrite closures are removed. |
| Markdown preview | Read-only text from `model`. Its Save is a record save but never counts as consent to overwrite. |
| Mobile bridge | Keeps publishing one projection per tab, so the wire format doesn't change. A mobile save becomes an edit plus a save on the record, and a rolled-back save is undone as an edit. |

## Migration plan

**Phase 1: the record for code-editor tabs.**

- **Change**: add the buffer slice. Move the draft, dirty flag, disk version, changed-on-disk mark, autosave pauses and save queue into the record. Per-tab fields become values read from it. Dirty state compares versions. Only closing the last view asks to save.
- **Deletes**: the per-tab copies, the panel `fileContents` cache for editable tabs, and content-compare dirty checking. `editorDrafts` becomes only the saved form of the record.
- **Tests**: two workspaces share one record; a view opened later sees the edits; undo back to clean; closing one view vs closing the last; hosts kept separate; Windows drive, UNC and `#` paths; merging old-format session drafts.
- **From #30714**: keep the URI shape, the save queue keyed by buffer, the close behavior and the tests. Drop the code that copies each store update to every tab of the file (`getSameBufferFileIds`) and `use-editor-buffer-content-sync`.

**Phase 2: reload and guarded saves on the record.**

- **Change**: reload applies as a version-checked, undoable edit. Keep My Edits records consent. Every code-editor save is a guarded write, and a refusal carries `currentSignature`.
- **Deletes**: the Undo toast and its saved snapshot of the draft and disk version, the `orca:editor-file-reloaded` event, and unguarded code-editor saves.
- **Tests**: a real text model; typing during the read; a watcher event during the read; undo and redo across a reload, and the autosave pause; Keep followed by another agent write; a file deleted on disk; CRLF, BOM and split emoji characters; a slow remote save racing a reload; a host without the capability.
- **From #30681**: keep the version check before applying, the programmatic-edit marker, cancelling reads already in progress, and the autosave pause at the undo boundary, now stored on the record. Drop its one-model-per-tab assumption and its per-tab session field.
- **From #30417**: keep `currentSignature`, Keep as consent, Save while the banner shows as overwrite, the deleted-file handling and the line-ending tests. Drop separate models per workspace, the branching on where the file was last edited, and the fallback to the store's draft.

**Phase 3: the remaining views.**

- **Change**: move rich markdown, notebook, CSV and both diff views onto the record as mapped above, and send mobile saves through it.
- **Deletes**: `diffContents` for editable sides, per-section save state, the "Discard your unsaved edits?" confirmation, and the last unguarded editor save.
- **Tests**: each view runs against a real model; edits in one view saved from another stay guarded; mobile round trips.

**Phase 4 (optional)**: sessions store records instead of per-tab drafts and still read the old format.

## Risks and open questions

- **Rich view round trips**: rich markdown or notebook serialization can rewrite bytes the user didn't touch and mark a clean file dirty. Each view needs a round-trip test, and should only replace the text when the serialized output actually differs.
- **Stricter dirty state**: retyping the original text still counts as dirty, as mature editors behave. Markdown users will notice, because the old check ignored trailing whitespace.
- **Aliases**: a symlink, a hardlink or a case-insensitive volume can give one file two records. The host's write lock and the guarded write refuse the stale save. Is resolving the real path on the host at open time worth the extra round trip?
- **Displayed paths**: for remote files, peek and go-to-definition show the owner folder. They need a display mapping.
- **Mixed versions**: new session and mobile fields stay optional. An old host's refusal has no `currentSignature`, so Keep falls back to consent for a single save.
- **Memory**: keeping models around for undo after closing must not keep records alive.
- **Open question**: how to show a dirty file whose host stays unreachable.
