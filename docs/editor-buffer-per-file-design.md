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
- Every writer goes through the record, and every view of the file is a projection of it.
- Dirty state comes from edit versions, not from comparing content.
- Reloading from disk can be undone.
- Every save, from any view, is checked against the disk when it is written.

**Non-goals:**

- Merging edits from several writers.
- A three-way merge screen.
- Host-side changes beyond the optional `currentSignature` field on a refused write.
- Treating symlinks or hardlinks to one file as a single document.

## Model

### Identity

The **record id** is the execution host plus a normalized path:

- **Host**:
  - `local`.
  - A WSL distro. `\\wsl$` and `\\wsl.localhost` paths name the same distro and give the same key.
  - An SSH target, keyed by target id, not by connection id or connection generation.
  - A runtime environment.
- **Path**: separators and drive letters are normalized. On volumes that ignore case (the default on macOS and Windows) the path is compared case-insensitively.

The workspace is never part of the id, and the id never goes over the wire.

The **text model URI** is separate. It can't change for the life of a model, and for hosts that aren't local it carries an `/.orca-owner/<hash>/` folder that keeps the file name last for the language service.

- **Owner resolves late**: when the owner isn't known yet, `editor-model-owner.ts` falls back to `unresolved` + worktree + file id. Once the owner resolves, that provisional record joins the real one:
  - If the real record doesn't exist, the provisional record is re-keyed to it.
  - If both exist and only one is dirty, the dirty one wins.
  - If both are dirty, the other draft is kept as a recoverable copy (see Restore).
- **Rename**: the record is re-keyed. The URI can't change, so a new model is created from the old model's text, dirty state and baseline, and the old model is disposed. Undo history doesn't survive a rename, which matches today's behaviour.

### Fields

| Field | Owns |
| --- | --- |
| `model` | The text model, which is the only editable copy. It is `null` for files Orca doesn't edit as text (too large, binary, image). Those records keep only `baseline` and `conflict`, and every write is refused. |
| `savedAltVersion` | `model.getAlternativeVersionId()` when the text last matched disk. Dirty means `getAlternativeVersionId() !== savedAltVersion`. The alternative id goes back to an earlier value on undo, which `getVersionId` doesn't. |
| `baseline` | The `getDiskBaselineSignature` of the decoded disk text that `savedAltVersion` matches (`src/shared/disk-baseline-signature.ts`). |
| `conflict` | `{ observed, consent? }`. `observed` is the disk version an outside change produced, or "deleted". `consent` is the version the user agreed to overwrite. |
| `autosavePause` | Why autosave is paused (restore check, disk check, undo past a reload), with a generation number so a save clears only the pause it saw. |
| `reloadBoundary` | The alternative version ids immediately before and after the last reload. |
| `saveQueue` | Runs this file's saves one at a time, with a single autosave timer. |
| `views` | The tabs and panes showing the file. Each keeps only its own scroll position, selection and mode. |

Version ids restart when a model is recreated, for example after a dispose and reopen or a rename. A new model is built from the record's text, and its `savedAltVersion` is set as follows:

- The record was clean: `savedAltVersion` is the new model's current id.
- The record was dirty: `savedAltVersion` is set to a sentinel the model can never reach, so the file stays dirty until the next save or reload.

### Lifecycles

- **Open**: the first view creates the record, setting the text, `savedAltVersion` and `baseline` in one step. Views opened later attach to it and see the current unsaved edits.
- **Close**: the view detaches. Only closing the last view asks to save. After that, the model follows the existing lifetime rules for undo after closing.
- **External change**:
  - A watcher event that matches a self-write stamp (an echo of Orca's own save) is ignored.
  - Otherwise, a clean record reloads, and a dirty record sets `conflict.observed`, which shows the banner on every view and pauses autosave.
- **Reload**:
  1. Note the alternative version id and the watcher's change counter, then read the file.
  2. Apply the result only if both are unchanged. It goes in as one undoable programmatic edit, then `savedAltVersion`, `baseline` and `reloadBoundary` are updated and `conflict` is cleared.
  3. If either changed, discard the result. If the disk text differs from `baseline`, set `conflict.observed` so the banner shows. If the user is still idle, retry, always with the newest change, so a file that keeps changing isn't left stale forever.
  4. Undoing back to the "before" id in `reloadBoundary` pauses autosave until the user saves or redoes.
- **Keep My Edits**: sets `conflict.consent` to `conflict.observed`, clears the banner and resumes autosave. It doesn't read the disk. The banner names the file but may not show the new content, so Keep is consent to overwrite content the user may not have seen. This is deliberate.
- **Save**:
  - Capture `{text, altVersion, baseline, consent}` in one tick, then do a guarded write that expects `consent ?? baseline`.
  - On success, `savedAltVersion` becomes the captured `altVersion` and `baseline` becomes the signature of the written text, unless a reload changed `baseline` while the save was in flight. The file is then dirty exactly when the user has typed since the capture. Undoing back to an older text after a slow save correctly shows dirty.
  - A refusal sets `conflict.observed` to `currentSignature`.
  - Autosave never recreates a deleted file. An explicit save may.
- **Restore**:
  - Sessions never store drafts. A draft is derived from each dirty record (its text plus `baseline`) when the session is saved, so a clean record can't leave one behind.
  - A restored record starts dirty, with autosave paused until the disk has been checked.
  - Sessions in the old per-tab format can have several drafts for one file with no ordering. Identical drafts are merged. A divergent draft stays as a recoverable copy, offered on the tab, until the user picks one or discards it. Orca never picks the newest by itself.
  - When an older Orca reads a session written by a newer one, it sees the derived per-tab drafts in the old shape plus optional fields it ignores.
- **Remote hosts**:
  - The guarded write runs on the host that executes it: the main process for local and WSL, the runtime for SSH and remote hosts. It is pinned to the connection that answered the capability check.
  - A runtime too old to have the capability falls back to the client reading the file and comparing it. That fallback isn't atomic.
  - If contact with the host is lost, the record and its draft stay. Nothing is thrown away or reloaded until the host answers again.

## How each view maps onto the record

| View | Mapping |
| --- | --- |
| Code editor and split panes | Views attach to `model` directly. |
| Markdown source mode | Same as the code editor. |
| Markdown rich mode | A commit is a user edit on `model`, so it can be undone and marks the file dirty. The view re-renders when the model changes. |
| Notebook | Cell edits serialize into `model`, and the notebook re-parses when the version changes. |
| CSV | Cell edits become range edits on `model`. The byte index is keyed by version. |
| Unstaged diff (single-file or combined section) | Only the modified side, which is the working file, attaches to the record and saves through it. |
| Staged and branch diffs | Separate read-only snapshot models, outside the record. |
| Markdown preview | Read-only text from `model`. Its Save is a record save but never counts as consent to overwrite. |
| Mobile bridge | Keeps publishing one projection per tab, so the wire format doesn't change. A mobile save becomes an edit plus a save on the record, and a rolled-back save is undone as an edit. |

Until Phase 3, the views that haven't been converted write through an **interim adapter**, `record.applyText(text, source)`. It replaces the model's text as one user edit, so even those writers keep the record consistent. The watch exceptions from #30415 that keep these views watched stay until Phase 3.

## Migration plan

### Phase 1: the record

Phase 1 ships as four PRs, each on its own.

- **1a. Record behind selectors.**
  - **Change**: add the buffer slice. Per-tab fields become values read from the record, and every writer goes through `applyText` or the model. Behaviour is the same, except that two workspaces now share one record.
  - **Tests**: sharing across workspaces; a view opened later; owner resolution re-keying and merging; host and path key rules (case, WSL aliases, SSH target id).
  - **From #30714**: keep the URI shape. Drop the per-tab fan-out (`getSameBufferFileIds`).
- **1b. Dirty from alternative version ids.**
  - **Change**: remove content-compare dirty checking. Recreating a model resets `savedAltVersion` as described above.
  - **Tests**: undo back to clean; dispose and reopen while dirty.
- **1c. Save queue per record.**
  - **Change**: one save queue per record. Only closing the last view asks to save.
  - **From #30714**: keep the close behaviour and its tests.
- **1d. Delete caches and stored drafts.**
  - **Change**: delete the panel `fileContents` cache for editable tabs and `use-editor-buffer-content-sync`. Drafts are derived when the session is saved, and old-format drafts are merged.
  - **Tests**: legacy drafts that differ for one file; a session read by an older version.

### Phase 2: reload and guarded saves

- **Change**: reload applies as a version-checked, undoable edit and retries with the newest change. Keep My Edits records consent. Every save is a guarded write, and a refusal carries `currentSignature`.
- **Deletes**: the Undo toast and its saved snapshot, the `orca:editor-file-reloaded` event, and unguarded code-editor saves.
- **Tests**:
  - Typing, or a watcher event, during the read.
  - Retrying under writes that keep coming.
  - Self-write echoes.
  - Undo and redo across the reload boundary.
  - Keep followed by another write.
  - A slow save followed by undo.
  - A file deleted on disk.
  - CRLF, BOM, and an emoji split across two characters.
  - A runtime without the capability.
- **From #30681**: keep the version check before applying, the programmatic-edit marker, cancelling reads in progress, and the pause at the undo boundary (now on the record). Drop its one-model-per-tab assumption and its per-tab session field.
- **From #30417**: keep `currentSignature`, Keep as consent, Save while the banner shows as overwrite, deleted-file handling and the line-ending tests. Drop separate models per workspace, the branching on where the file was last edited, and the fallback to the store's draft.

### Phase 3: the remaining views

- **Change**: rich markdown, notebook, CSV, unstaged diffs and mobile saves become native projections of the record, as mapped above.
- **Deletes**: the interim adapter's callers, `diffContents` for editable sides, per-section save state, the "Discard your unsaved edits?" confirmation, and the #30415 watch exceptions.
- **Tests**: each view runs against a real model, and an edit made in one view then saved from another is still guarded.

## Risks and open questions

- **Rich view round trips**: rich markdown or notebook serialization can rewrite bytes the user didn't touch and mark a clean file dirty. Each view needs a round-trip test, and should only replace the text when the serialized output actually differs.
- **Stricter dirty state**: retyping the original text by hand still counts as dirty. Markdown users will notice, because the old check ignored trailing whitespace.
- **Aliases**: a symlink or hardlink still gives one file two records. The host's write lock and the guarded write refuse the stale save.
- **Displayed paths**: for remote files, peek and go-to-definition show the owner folder. They need a display mapping.
- **Memory**: keeping models around for undo after closing must not keep records alive.
- **Open question**: how to show a dirty file whose host stays unreachable.
