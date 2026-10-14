# phase-o-1 · First usable plugin release

_Concrete design and implementation gates · updated 2026-10-14 against source code and running-app probes. This defines the complete phase, not a claim that every contract is implemented. It takes precedence over broader proposals where it narrows this phase._

Start with the [release blueprint](phase-o-1-design.md) for scope, user flows, host boundaries and delivery order. This document retains the detailed contracts and qualified implementation evidence.

## 1. Outcome and scope

A user can discover a plugin, understand what it does, install it, and use it without editing Orca or running a build command. An independent maintainer can publish an update without a core PR. The first release proves four extension types through that same system. Environment providers are P0:

| Type                    | First proof                                                                               | User action                     |
| ----------------------- | ----------------------------------------------------------------------------------------- | ------------------------------- |
| P0 environment provider | Company CLI for long-lived devboxes and ephemeral sandboxes; reviewed SSH handoff | Review account → create/list/sleep/wake/archive/delete → connect |
| Interface language      | One independently maintained partial locale; one existing locale packaged as bundled data | Install → Use language          |
| Coding-language syntax  | Two data-only grammar packs, including one migration of an existing bundled grammar       | Enable → open a matching file   |
| Additional file formats | Read-only XLSX plus an independently authored, non-spreadsheet viewer                     | Install → open file / Open with |

The second viewer exercises binary transport: the independent binary STL package now renders a mesh through the same public SDK and native installed-package flow. Other formats can implement the general contract without adding format-specific app branches.

Environment providers reuse the existing SSH and managed-server lifecycle, with host-owned account context, review sessions, durable operation receipts, saved target generations and retained history. Installation executes no provider code. Data packs cannot acquire these executable instructions through an unreviewed change. See [environment recipes](environment-recipes.md) and [Node control-host composition](environment-node-ssh.md).

Ship a visual directory, installed-plugin management, strict package classification, explicit updates, and a shared author/release workflow. Retain existing theme and panel functionality. Task systems, custom sidebars, agents, skills, and other families remain intended expansion lanes; this phase adds no new provider contract for them.

No spreadsheet saving, language servers, native document converters, arbitrary installation scripts, migration of every built-in language or general remote worker runtime. Approved environment recipes run their exact reviewed CLI commands on the selected control host; they are separate from data-only language/syntax packs. No automatic executable updates. Public directory deployment and repository creation are separate delivery actions, not completed by this design.

## 2. Baseline we reuse

Existing: publisher-qualified package identities, immutable install trees/current pointers, system-Git sources and private credentials, provenance lockfiles, marketplace plumbing, bounded artifact validation, core locale loading/fallback, lazy workers, sandboxed sidebar panels, and revoke/disable paths.

The uncommitted security follow-up fingerprints panel UI, opened-file viewers and Node-worker presence separately. A previously approved data pack gaining code remains pending. A panel package gaining opened-file access also requires fresh approval, even within `sandboxed-ui`; real service tests cover those transitions. Legacy panel approvals need one fresh review. This is the starting security behavior, not the entire profile system.

Current worktree adds strict v2 profiles, pinned catalog releases, source-bound v2 approval and exact release-review receipts, drift-aware locales, catalog browsing/detail UX, and approved metadata/lazy syntax content. Verified data installs and ordinary updates take one action; Use language is visible in the catalog and installed rows. Native Electron journeys install two syntax packs, color ordinary/read-only files and visible inline diffs, choose persistent syntax associations, update an open diff, disable/re-enable, remove a pack and recover after restart. Strict viewer declarations, a separate opened-file approval marker, approved metadata and inert source loading now share the package registry. The execution-host binary-session foundation has real-file ownership/revision/revocation tests. A versioned surface protocol, frozen SDK and parent-owned worker lifecycle produce actual text/table/canvas from a binary fixture in a native probe. The native guest coordinator now derives document authority from the approved registry and exact bound guest; its fixed preload/IPC, exclusive-process check and bounded private session pool pass native tests. The app now installs and approves a real fixture release, then opens text, virtualized tables and interactive canvas through normal viewer tabs. Native journeys prove sheet selection, canvas zoom with changed pixels, scrolling, restart, file reload and immediate disablement. Direct SSH now has negotiated leases and native Git/folder, repair and reconnect evidence; paired-runtime Git/folder viewers now have native loopback, nested SSH and actual managed Linux startup evidence; Windows/WSL parity and watches remain incomplete. Included Spanish and Typst now work with optional plugins off, with separate disable/restore controls and preserved installed pins. Local syntax load, file-limit and worker-budget failures now have model-owned explanations and Retry. Packaged/app-upgrade migration gates, broader diff/platform viewport/undo and failure recovery, remote lifecycle evidence, binary transport/watch integration, complete promotion/decline/rollback UX and completed release/platform delivery remain required. Independent author tooling and the static public directory now have local integration evidence. The local report separates verified work from those gates.

Target clients: Electron desktop on macOS, Windows, and the supported Linux/glibc floor, with native and SSH workspaces, including folders without Git. Include WSL in the host capability matrix and ship that combination only after the same authorization tests pass. Keep shared contracts transport-neutral; standalone server, paired web, and mobile report unavailable for unsupported operations. Shared RPC registration alone does not establish their support.

## 3. Package contract and the data boundary

### Manifest v2

Introduce `manifestVersion: 2` with a required `execution` field, strict top-level validation, strict contribution objects, and a finite supported field set. Keep `pluginApi: 1` experimental and require the minimum Orca release implementing this phase. The numeric minimum is set when that release is assigned; examples below are fragments, not installable manifests.

Why v2: today's v1 top-level parser ignores unknown fields. Adding an optional `dataOnly` flag to v1 could make a safety constraint disappear on older hosts. Their existing literal-version check rejects v2 instead.

| `execution`      | Allowed contents                                                                                         | Approval                                                                                                                           |
| ---------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `data`           | Locale catalogs, syntax JSON/configuration, validated app/icon/terminal theme data; no host capabilities | User's explicit Install/Enable action approves optional packs; exact bundled data snapshots can activate from app-release metadata |
| `sandboxed-ui`   | Data plus panels/file viewers; no Node entry or instructional effects                                    | Review executable UI and opened-file authority before activation                                                                   |
| `instructional`  | Data plus approved aliases/keybindings, recipes, launch instructions; no worker/UI code                  | Review the exact instructions and their changed bytes                                                                              |
| `trusted-worker` | A required Node entry; may include other known contributions                                             | Full-trust worker disclosure and host-capability review                                                                            |

The host derives the minimum execution class from declared contributions and rejects an inconsistent claim. `data` forbids `main`, panels, viewers, commands, events, keybindings, recipes, agent launches, scripts, and executable module/configuration fields. Grammar regexes remain data interpreted by a bounded host engine, not permission to import JS. Unknown fields fail validation; the category, publisher name, file extension, or package description never grants trust.

One package can combine contributions only within its declared class. Standalone locale and syntax templates declare `data`. A package can intentionally become executable, but it then becomes a reviewed package of a different class.

### Update / local-edit state machine

`available → staging → validated → pending approval or active → disabled / removed / revoked`

Installation validation and preview run host code only. No candidate worker or viewer loads to demonstrate its own permissions. Persist approval against package identity, execution class, canonical host capabilities, relevant instructional content identity, and reviewed source ownership. The v2 implementation binds repository URL, installation kind, catalog URL/channel and declared catalog owner, or the canonical development folder/bundled identity. Release tags and commits can advance without changing data authority. A separate review receipt binds that authority to exact package bytes; main rechecks it under the installer mutation queue before recording approval. Legacy v1 remains on the experimental approval path. File-viewer declarations add a sandboxed-UI execution marker before that API is exposed.

For data → UI/worker/instructional promotion, or a reviewed source/owner change:

1. Stage and classify the complete candidate. A `data` manifest containing code is invalid, not merely awaiting approval.
2. If the author correctly changes its class, leave the candidate pending. Existing approval cannot activate it; toggling Enable does not approve it.
3. Show **“This language pack now adds executable UI”** or the full-trust worker explanation. Approval must match the current fingerprint; a stale dialog cannot approve a different candidate.
4. On approval, atomically publish/reconcile. On decline, retain the verified previous release or a host fallback; never activate the candidate.

Mutable development packages use the same gate. A changed development manifest cannot preserve an old snapshot implicitly: pending promotion removes its effective contributions until review or restoration of a valid data tree. Editing both Orca and its approval store with OS authority is outside this package boundary.

V1 installed packages remain readable behind the existing experimental/advanced path. Never treat a v1 package as a strictly verified data pack without revalidation. A v1 → v2 upgrade goes through review once; ordinary later valid data updates use the explicit Update action without repeated code-permission dialogs. Rollback revalidates compatibility, provenance and revocation, and cannot resurrect a revoked release.

### Earlier packaged cohort evidence

Two actual hidden-window journeys launch the production macOS arm64 directory package (`app.isPackaged`, `app.asar`, Electron 43.7.5), with no renderer store hook. They pass together in 40.5 seconds. The included-data journey preserves a preexisting-style saved Spanish preference with optional plugins off, opens shipped Typst and a catalog-installed grammar, installs/reviews XLSX and STL releases, opens both through ordinary Explorer in a non-Git folder, repairs malformed bytes through Retry and restores the workbook after restart. This simulates an old preference; it does not run an older app binary.

Separate native traces identify the real dedicated parser workers and their owned frame processes. The observed STL/XLSX process aggregates are about 299/309 MiB and 0.253/0.295 cumulative CPU seconds at the captured samples. These are observations for the small corpus, not hard resource ceilings or large-file performance guarantees. Another installed-parser journey repeats memory growth, an idle infinite loop and invalid-message flooding twice each; every affected pair of native PIDs retires, Settings stays usable and visible Retry creates a fresh working session. Memory-growth samples peak around 978–996 MiB before retirement, illustrating the overshoot of the sampled 768 MiB policy.

The real packager verifies four shipped plugin snapshots. A regression also found that its broad file matcher included task scratch files; `.tmp` is now excluded, and the actual package verifies scratch files, independent author sources and public-directory output are absent from `app.asar`. Package configuration/resource/gate tests pass 82 cases across three files. Twelve actual captures and package/resource hashes are recorded in the local HTML report/evidence directory.

Scope: unsigned local directory package, macOS arm64 and local folder files. No installer, notarization, prior-binary app upgrade, packaged SSH/WSL/runtime, Windows/Linux, GPU ceiling, full API/network audit or public deployment claim. Those release gates remain open. Reproduce these tests with `ORCA_PHASE_O_1_PACKAGED_EXECUTABLE` set to an actual production executable; the two `plugin-packaged-*.spec.ts` tests deliberately skip when it is absent, so a normal development E2E run cannot count as this gate.


## 4. Bundled languages without a separate plugin experience

Move one current non-English locale and one portable bundled grammar through the package pipeline first. Expand to all language content after the migration gate passes.

An app build assembles pinned source releases into `resources/plugins/launch/` with exact hashes in `bundled-plugins.json`. Reuse bootstrap/integrity code, but split **bundled data availability** from **third-party plugin enablement**. Disabling optional plugins must not remove default languages. The bundled-data activation path accepts only profile-validated data snapshots from trusted app metadata; it must reject UI, worker, and instructional packages.

Retain English recovery text, reviewed security translations, translation/grammar engines, and necessary host adapters in core. Legacy `uiLanguage` settings map to the migrated official package selection; existing startup does not ask a user to install a language they already had. Keep English available even if every plugin is disabled or invalid.

An app-owned alias map resolves migrated built-in language IDs to their qualified bundled contributions. Switch file detection and open-model language selection through that map before retiring the old registration. A community manifest cannot assign itself a built-in alias or use an official-looking name to take precedence.

Selection priority: explicit user choice/version pin → compatible approved optional update of the same package → the app's verified bundled snapshot → English/plain text. Never switch publishers silently. Persist user disablement of an optional override; do not copy a newer bundled release over their pin. Kill-list policy can make either snapshot unavailable and always precedes this priority.

The current bundle index is capped at 32 packages. The initial sample fits it. Raising it for the all-language migration requires bounded discovery and packaged-startup measurements rather than an unbounded list.

**Migration gate:** same locale formatting/plurals, main/renderer translations, grammar behavior, startup without network, third-party-off behavior, update precedence, explicit user choices, and built-artifact hashes. Do not delete core copies before these pass.

The initial local migration now ships Spanish and Typst as immutable v2 data snapshots. The bundle registry validates their complete trees against app-owned index hashes and rejects executable or instructional profiles. It activates these snapshots independently of optional-plugin discovery and consent; they never become user-installed pointers. The ordinary legacy bootstrap skips their index entries. Development packages and community packages cannot inherit their host-owned aliases or approval.

Settings exposes a separate **Included with Orca** section, even with optional plugins off. Each family has a persistent disable/restore preference stored through a dedicated host operation; generic settings updates cannot edit it. Disabling preserves the selected language or syntax preference and temporarily uses English/plain text. An approved, compatible optional release from the official source takes precedence when optional plugins are enabled. Turning optional plugins off restores the bundled fallback without rewriting the installed pointer. If the shipped snapshot is missing or invalid, an independently approved official data release can still serve the host-owned alias; without an approved replacement, the family stays unavailable and uses English/plain text. App-owned resources cannot be removed through the user-package operation.

Both translation consumers map saved/System Spanish to the verified resource and use Spanish plural rules for its internal resource ID. Missing or stale translations fall back to English; only core-reviewed protected copy uses the retained Spanish security resource. Typst's existing language ID maps to the verified package and terminable grammar worker. Explicit Plain text or publisher-qualified selections keep precedence. New clients negotiate alias metadata; older syntax decoders receive the original payload shape. Core copies remain for the legacy-host path pending the full client/host migration gate.

Local evidence includes real main/renderer translations and plural tests, actual worker highlighting, same-profile restart, disable/restore, optional installed-release precedence and unchanged pins. Two fresh background macOS journeys pass in 30.8 seconds. The latest initialization timings are recorded with their environment in the local evidence JSON; these development-build observations do not establish packaged startup budgets. The current macOS production package now verifies shipped resources and these initial consumers. An actual prior-binary app upgrade, additional packaged platforms and supported client/host combinations remain gates before expanding the migration.

## 5. Locale contract and maintainer workflow

Retain `contributes.languagePacks: [{ locale, path }]`. New artifacts use a versioned envelope:

```json
{
  "formatVersion": 1,
  "locale": "pt-BR",
  "displayName": "Português (Brasil)",
  "sourceRevision": "sha256:<kit-digest>",
  "entries": {
    "workspace.open": {
      "sourceHash": "sha256:<entry-digest>",
      "value": "Abrir espaço de trabalho"
    }
  }
}
```

The exporter flattens today's source catalogs into canonical keys; runtime reconstructs only validated resources. Hash canonical source text plus placeholder/plural/context signature, not component file modification time. Generated component-path keys continue to work; explicit key migrations cover moves. A key migration does not mark changed source text reviewed automatically.

Retain today's 5 MiB artifact limit, 20,000-entry traversal ceiling, depth/leaf-size bounds, safe keys, and protected-copy rules. Account for envelope overhead within those limits. Verify locale tag and declared/envelope agreement, interpolation names, plural/context variants, string escaping semantics, and source fingerprints. Pack resource IDs remain distinct from formatting locale tags.

Effective behavior: current valid translation → translated text; missing/stale/obsolete translation → English; invalid structure/placeholders/protected overrides → reject the candidate artifact and keep the previous valid release/fallback. Coverage counts current eligible source keys, excluding core-owned security copy. Show coverage and stale count separately; 80% coverage is not a security score.

Generate a translation kit and a CLI/library verifier from the runtime schema. Author loop: refresh kit → inspect added/changed/removed entries → human review → verify → preview → release. Pin shared tooling in CI. Opt-in automation can prepare a refresh PR later; it must never mark translations reviewed or publish on a contributor's behalf by default.

Plain v1 JSON catalogs remain supported only on the experimental legacy path and are labeled “source freshness unknown.” New templates and bundled migrations use the envelope; no promise of drift detection for legacy files.

## 6. Syntax packs

Manifest v2 adds `languages` and `grammars` under `contributes`:

```json
{
  "execution": "data",
  "contributes": {
    "languages": [
      {
        "id": "example-lang",
        "aliases": ["Example Language"],
        "extensions": [".example"],
        "filenames": ["Examplefile"],
        "configuration": "language-configuration.json"
      }
    ],
    "grammars": [
      {
        "language": "example-lang",
        "scopeName": "source.example",
        "path": "syntaxes/example.tmLanguage.json"
      }
    ]
  }
}
```

Use a bounded JSON configuration subset: comments, brackets, literal auto-closing/surrounding pairs. Arbitrary callbacks, JS modules and extra configuration regexes are excluded initially. Permit declared package-local grammar includes; reject missing scopes, global injection and cross-package dependencies.

The current contribution/artifact validators enforce 16 languages and 16 grammars per package, 2 MiB per grammar, 8 MiB total grammar data, 64 KiB literal configuration files, and JSON nesting depth 64. Validate these release defaults against the complete sample corpora before freezing the API. Core filename/extension ownership remains authoritative unless the user chooses a supported plugin association. Conflicting plugin claims use a chooser. The current picker offers Automatic, Plain text and qualified installed packages, persists at most 128 filename/extension rules, and reports a missing selected package rather than silently choosing another publisher. Actual native update/removal, restart, ordinary editor viewport/Undo and initial load/size/worker-budget recovery journeys pass; broader diff/platform recovery and remote behavior are still gates. Internal language IDs are qualified to the package; public aliases/scopes do not establish ownership.

One host registry owns qualified package/contribution identities, configuration and tokenizer disposables per generation. Monaco’s public language-metadata registration has no disposal handle. Use a bounded, lazily registered pool of host-owned editor IDs (initial ceiling: 512 active language slots), with no author extensions or aliases registered into global detection. Slot assignments are transient; persisted associations and user-facing choices remain publisher/package-qualified. Reassign a slot only after previous models have moved to their fallback and its worker/features have been disposed. Build the language picker from the active host registry, never inactive slot metadata.

Lazy loading is generation-aware. Replacement/disabling/removal disposes features and grammar state, cancels pending work and retokenizes affected models; text and edit history remain host-owned. Reconcile file detection for normal editors, read-only models and diffs. Prove slot reuse cannot resurrect a previous owner’s tokens. A slot limit is a bounded host-capacity state with a clear fallback, not permission to register an unbounded lifetime of deleted languages.

**Isolation probe and selected integration:** grammar evaluation runs in a host-owned killable browser worker. The initial asynchronous semantic-provider experiment could color ordinary editors but missed the visible original text in inline diffs. The supported synchronous adapter therefore reads a worker-prepared token cache; its callback performs string/map lookup only, with no author regex evaluation on the renderer. Missing cache entries render plain text.

Cache complete preceding-text prefixes in a bounded trie, which is stronger than relying on a possibly stale preceding grammar state. Worker requests and replies carry request ID, model version and plugin generation. Apply a complete snapshot only while its model/version/generation is current. A cache is owned by one grammar generation; states from another cache, an evicted epoch or an unknown prefix return plain text. Initial ceilings: 500,000 model characters, 20,000 model lines, 100,000 classified tokens, 8 queued model requests and 2,000,000 cached prefix characters/80,000 cached lines per active grammar. Prefix states hold weak references so editor state cannot retain evicted cache trees indefinitely.

Refresh the public token-provider registration after a verified snapshot. Inline diffs additionally need a host-owned refresh of their deleted-line view: the probe uses the public model colorizer to complete cached tokenization, changes/restores the known indicator option within one task, and restores saved diff view state. The production adapter must preserve the host’s actual option values and batch this refresh; it must not force an indicator preference, change text, or reset undo. These details are implementation constraints from the running-app probe, not a new plugin API.

Target worker work slices at 100 ms, kill/recreate after a 2-second missed-progress deadline, and impose a 30-second total document deadline even if progress continues. Abort active evaluation on model change/disposal and on plugin replacement/disable. A worker can finish a bounded regex earlier or be terminated; a cooperative main-thread timeout is never the recovery mechanism. Diagnostics omit source lines.

The real Electron probe demonstrates multiline comments, changing an opener, read-only rendering, visible inline-diff original/modified highlighting, typing in Settings while a hostile grammar runs, worker timeout/recreation, disposal, and closing a dirty tab through its normal confirmation. A separate production journey now installs two independent data syntax fixtures through real Git/catalog/IPC, colors ordinary/read-only files and visible inline diffs, and proves immediate disable/re-enable. The qualified registry, lazy host-slot allocation, 50 ms edit coalescing and global fair scheduler are implemented; initial aggregate limits are eight active grammars, two evaluating workers and eight queued jobs. Workers release their resources when work finishes, and payload deduplication retains only in-flight loads. Unit checks cover late responses after slot reuse and changed revisions on an existing model.

A further native production journey uses real keyboard typing in a 360-line document, switches Plain text/Automatic, and verifies unchanged selection, settled scroll position, text length and available Undo. Actual Undo restores the original edit and Redo reapplies it, with worker colors returning for both versions. The baseline waits for Find’s scroll animation to settle; no editor state is reset to make the assertion pass.

Failures carry bounded host-owned reasons: load, file size, work capacity, worker budget or invalid worker output. Each warning belongs to the exact model URI, qualified grammar and revision. Ordinary and read-only editors expose Retry and the existing Plain text syntax choice without resizing the editor or changing text/history/view state. Diff warnings use the actual original/modified model URIs and identify the affected side. Cancellation, disposal and stale generations cannot publish a warning. Successful current token snapshots clear that model’s warning; Retry reloads a failed payload or starts fresh worker work only for that model. Unit tests prove capacity release, stale/disposed suppression and same-path execution-host isolation. The local installed-package journey proves malformed payload rejection, repaired-load Retry, repeated hostile-worker deadlines, a healthy neighboring file and edit-preserving recovery after a file limit. The fresh 24.8-second native recovery journey also proves that typing into an oversized read-only document changes neither model length nor disk bytes; its Plain text/Automatic choices hide and restore the warning. Lazy metadata admission now records SHA-256 digests for every bounded grammar/configuration read and freshly verifies the complete installed tree after that capture. Subsequent loads must match those exact referenced bytes before parsing or exposure; development changes require a new host generation. The host retains only digests, not every package’s full grammar payload. Tests reproduce and reject valid same-revision grammar/configuration edits and an initial verification/read race. The fresh native journey refuses both valid changed JSON and malformed bytes, then resumes on exact restoration through Retry. This proves referenced-artifact identity; it does not promise continuous full-tree rehashing of unused files or defend against an OS actor editing Orca and its approval store.

A further two native journeys pass in 38.5 seconds. A real nine-grammar catalog package highlights eight files and gives the ninth a capacity explanation while keeping it editable; typing keeps the explanation accurate, and closing an actual earlier tab admits the waiting grammar with the unchanged user edit. Complete keyboard Undo/Redo restores the original text through normal word-sized edit groups and reapplies it. The real Git diff journey proves an oversized Original with a healthy Modified, Original typing refusal, and three Plain text/Automatic cycles preserving both exact model URIs, selections, settled scroll positions, text lengths and Undo availability. Real modified Undo/Redo returns fresh colors; the reverse fixture names the failed Modified side in inline mode. The diff observer is read-only and exists only in E2E builds.

O1-06 still requires broader combined diff budget/load failures and packaged viewport/Undo, plus packaged cross-platform/SSH/folder lifecycle evidence. Native associations, conflicts, update/removal, restart and the initial bundled Typst migration are verified. These native fixtures do not establish remote or release-package parity.

## 7. General file viewers

### Declaration, resolution and tab state

```json
{
  "execution": "sandboxed-ui",
  "contributes": {
    "fileViewers": [
      {
        "id": "workbook",
        "displayName": "Workbook",
        "selector": [{ "filenamePattern": "**/*.xlsx" }],
        "entry": "dist/workbook.worker.js",
        "rendering": "host-ui",
        "mode": "readonly"
      }
    ]
  }
}
```

Initially accept bounded filename/extension glob matching, not author regexes. Proposed limits: 16 viewers/package, 16 selectors/viewer, and 256 characters/selector. Reuse bounded entry loading and realpath containment, with a 10 MiB prebuilt worker-entry limit. Dependencies are bundled; no install scripts or network imports. `rendering: "host-ui"` is the only initial rendering mode: the plugin parses and produces validated view data, while Orca owns the controls and rendering. Arbitrary author HTML is not a file-viewer entry in this phase.

Host-owned viewer surfaces initially cover text, virtualized tables and an interactive canvas, so additional file formats are not limited to spreadsheets. The workbook package uses sheets/tables; the independent binary package uses canvas. The shared v1 worker protocol now binds session, generation and request identity; metadata and viewport requests use the control lane, document bytes use the byte lane, and canvas output stays inside the isolated viewer renderer. No unvalidated worker value becomes HTML, a style, a URL, a navigation target or a host IPC argument. Later custom DOM surfaces need a separate reviewed contract; existing experimental panels do not inherit opened-file authority.

Initial surface bounds: 64 KiB aggregate control output and a separate 4 MiB aggregate table-data lane, 100 uniquely identified sheets, 1 million declared rows and 16,384 columns, and at most 64 × 64 requested table cells. A text viewport has at most 64 lines; individual strings have an 8,192-code-unit ceiling within the aggregate UTF-8 budget. Sparse table output must remain within the requested rectangle and actual sheet dimensions. Cached formulas are labeled data, not computations. Canvas output is an exact owned RGBA buffer, at most 2,048 × 2,048 / 16 MiB, with no hidden backing-buffer tail or shared memory. Output dimensions must match the host viewport; only finite, bounded camera values are accepted. Validate these defaults against the format corpora before freezing the release.

The native table now exposes one focusable read-only grid with indexed sticky row/column headers and a selected cell. Arrow keys, Home/End, Page Up/Down and platform Cmd/Ctrl+Home/End reveal the selected virtual cell without rendering the whole sheet. Enter, double-click or Cell details opens a host-owned popover with the full bounded value, a cached-formula explanation where applicable, and Copy value. Platform Cmd/Ctrl+C also copies the selected grid cell. Native copy-event acknowledgement retains the temporary selection until delivery and restores prior focus. Escape returns focus to the grid. Copy crosses a fixed selection-only command: no supplied clipboard text, clipboard reading, author SDK method or arbitrary IPC. Main rechecks initialized guest/frame/session, exact current approval, exclusive renderer process and a short copy rate limit before invoking the native edit command. This is host UI, not an author capability. A real background macOS app journey verifies trusted key and copy events; the test prevents the OS clipboard write and does not claim a clipboard round trip. Packaged platform parity remains required.

The worker author API is a frozen `orcaViewer` object installed before importing the separate prebuilt script. Authors register `open(document)` and `render(viewport)` and use `readBytes(position, length)`; they do not supply a document handle, path or owner. The trusted host fills handle/revision from its session. Viewport requests coalesce to the latest pending request, and superseded output is discarded. Worker source is loaded inertly from the exact approved package; metadata discovery exposes neither source nor entry paths.

The SDK/controller first passed a native integration probe: three workers read a real binary fixture through a sender-bound, main-frame-only test transport and produced actual text/table/canvas DOM results. Authored markup stayed plain text; the wrong renderer could not use the handle. The subsequent installed-package journeys described below exercise the production coordinator and normal viewer tabs. The prototype alone does not establish those contracts or platform/remote parity.

Resolution: saved user association → existing core default → a unique compatible enabled plugin viewer → chooser/fallback. A package cannot displace existing core previews just by declaring a match. “Open with” lists available core/plugin choices and a deliberate default action. No-match files retain the existing unavailable/open-external behavior where supported.

The [file-opening contract](phase-o-1-file-opening.md) defines the resolver decision table, pending-metadata and conflict surfaces, explicit Open once / Set default and open actions, bounded settings rules, source intent, split/tab transitions and restart gates. Automatic resolution and saved qualified defaults now have native Explorer/restart evidence; they remain required behavior of the general file-opening contract. Source editability is distinct from parser read-only state, and older parser sessions fall back to a read-only source.

Source intent now persists as a strict optional host-owned `sourceView` containing only read-only and log-tail flags. Parser tabs force read-only state at the store boundary, ignore dirty drafts, and never interpret log-tail intent as parser authority. Reusing a parser updates source intent while preserving its viewport, and viewport updates retain source intent. The actual native journey returns a log through Open with, restarts the parser, rejects real typing and displays appended log content. Its ordinary-document control closes the original source tab before restarting the parser, then returns to a newly created editable source and types visibly. These prove native source intent. The shared file-opening action now selects unique approved viewers, protects existing core handlers, and uses a neutral waiting/choice surface before metadata resolution. Actual Explorer journeys verify automatic XLSX opening, conflicting contributions, an unresolved choice across restart, Open once, saved qualified defaults, reset and disabled-default recovery. Split/pinned/preview and dirty-source transitions have unit coverage; native non-Git folder splits now have separate lifecycle evidence; remote and packaged-platform gates still apply.

Persist `{workspaceId, fileResource, viewerKey, viewStateVersion, viewState}` in a normal split-capable tab. `viewerKey` is package-qualified. Limit view state to 16 KiB; XLSX stores sheet/scroll, not cells. Handles, document bytes, credentials and absolute host-local substitutes are not persisted. Restoring a tab reauthorizes and rereads.

### Document session and byte protocol

Host-created session ownership binds the actual execution host, workspace/folder, opened file, plugin generation, tab/client and revision. A filename match selects a viewer; user opening that file authorizes read-only access for that session. The plugin supplies no arbitrary path. The host controls chrome, close/reload, errors and recovery.

Proposed wire contract, with parameter/result validation and closed error codes:

```ts
interface ViewerDocumentInfo {
  documentHandle: string
  name: string
  size: number
  revision: string
  mimeHint?: string
  features: { rangeRead: boolean; watch: boolean }
}
interface ViewerReadRequest {
  documentHandle: string
  revision: string
  position: number
  length: number
}
interface ViewerReadResult {
  revision: string
  bytesRead: number
  contentBase64: string
  eof: boolean
}
```

The frame receives document info after the same executable-UI approval as installation. Host ownership is bound by transport/session, not passed as a client-controlled identity. `viewer.readBytes` and change notifications are the only file authority. No siblings, directories, writes, terminal commands, raw sockets, secrets or network grants.

Initial byte-lane limits: 192 KiB decoded/chunk (256 KiB base64 before envelope), at most 2 requests in flight/session, 50 MiB document input, and 2 simultaneously loading viewers. Cache at most one bounded fallback snapshot/session; count rereads against a 100 MiB lifetime-transfer allowance before an explicit reload creates a fresh session. Keep existing ordinary-message flood limits and liveness capacity; do not route bulk bytes through the current 64 KiB/30-per-10-second panel-call budget. Batch scheduled work fairly so one viewer cannot starve control traffic. Set limits in shared constants and test encoded plus decoded accounting.

Authorization and regular-file/symlink/identity checks run on the filesystem's execution host, with positional reads from an authorized handle where supported. A raw path-based range API alone is insufficient. The initial remote implementation requires negotiated viewer-document leases. Older hosts return `unsupported_host`; no snapshot or broad workspace-read fallback is implemented. Never transfer the whole file again for every range.

The current execution-host foundation reuses the preview reader's canonical authorization/open seam. It binds all six owner dimensions, verifies regular-file identity and nanosecond modification/change times before and after each positional read, and rejects replacements or changed symlink targets. Shared constants enforce decoded/encoded chunk bounds, 8 live sessions, 2 pending opens, 2 concurrent reads/session, 4 concurrent reads/host and the lifetime allowance. Authority is rechecked after I/O. These modules are tested against real files. The native coordinator now exposes them through a private, main-frame-only preload/IPC bridge after exact guest/session/process and approval checks. Approved source is withheld until initialization finishes; reads are denied before that point. The native architecture probe uses controlled approved metadata and real file bytes. A separate app journey uses actual catalog-installed parser entries, the production mint API, restricted guest attachment and the private read bridge to open normal text/table/canvas tabs. `watch: false` is truthful until watch integration exists.

The SSH filesystem provider now implements a separate version-1 viewer lease lane, advertised in the shared filesystem capability document. The relay holds the authorized regular-file handle and derives client identity from the actual transport; the privileged native connection supplies the app/plugin owner fields. Exact executable approval remains the native coordinator's responsibility. Each lease also has a client-created UUID, so cancellation or a lost open reply can close the host resource before its document handle is known. Disconnect, failed response delivery, stale revision and handler suspension retire the lease. The provider pins its original multiplexer and validates revision, EOF, byte counts and canonical bounded base64 before decoding. Old hosts fail closed; reconnect negotiates capabilities independently. Real framed-RPC integration tests use the production provider, multiplexer, dispatcher and filesystem handlers with actual files, including a full 192 KiB chunk. Those cases use in-process transport tests. Native SSH routing now resolves the owning Git worktree or folder from the main process catalog, pins the actual filesystem/Git provider objects and connection generation, and rechecks them before admission and every read. The host confirms Git roots against its actual worktree list; ordinary folders need no Git lookup. Invalid, ambiguous or changed owners fail closed. A named user-file access remains a narrow document selection, not a workspace read grant. Provider removal retires the private guest and remote handle. Explicit Reload can capture a new connection generation only for the same execution host and runtime owner; moving the workspace to another host requires reopening the file. Actual background macOS Electron against a disposable Linux OpenSSH host proves remote-only XLSX and STL opened through Explorer, malformed-file recovery, disconnect retirement and explicit reconnect reload. A separate non-Git remote folder workspace opens its workbook through the same lane, with assertions bound to its exact visible guest. The fixture files do not exist at those paths on the client. The paired-runtime adapter now has separate native evidence below; Windows/WSL parity, watches and packaged platform journeys remain release work; older hosts continue to show unsupported connection without a native or whole-file fallback.

Require revision equality for each read. If the file changes, cancel the old load and show a Reload action; do not mix bytes from different revisions. Watch notifications carry only revision/state; missing watch support yields manual Reload. Disconnect, close, disable, update, owner loss and revocation cancel reads and invalidate the handle. Coalesce provider watches for the same file and release the last subscription.

Closed error codes: `unavailable`, `invalid_request`, `unauthorized`, `stale_revision`, `unsupported_host`, `limit_exceeded`, `cancelled`, `read_failed`. Show translated host-owned explanations and retry/reload/alternative actions.

### Parsing and first packages

The public worker contract now ships as a small independently buildable SDK. Separate `orca-viewer-xlsx` and `orca-viewer-stl` authoring packages include source, exact dependency lockfiles, a source-bearing SDK archive, licenses and prebuilt worker entries. Native catalog installation, explicit approval, real producer XLSX values/sheets, dense horizontal scrolling, malformed-file Retry, and binary STL pixels/orbit/zoom pass through this same API. The XLSX corpus has 41 tests; STL has 10. Standalone cross-platform CI is prepared. These repositories have not been externally created or published. The host requests the visible table area, and table data has its own 4 MiB ceiling because a valid dense table exceeds the ordinary 64 KiB control cap; controls and text retain their existing limit. Oversized responses fail explicitly. Cell inspection, platform selection-copy delivery and native aggregate process accounting now have evidence. Broader hostile/parser corpora, OS clipboard round trips and packaged/remote parity remain required.

The [viewer process and resource contract](phase-o-1-viewer-resources.md) specifies actual frame ownership, identity fencing, per-viewer/aggregate sampled budgets and recovery. Native tracing places the parser worker in a separate child-frame renderer; checking the top guest PID alone is insufficient.

Use a separate viewer renderer with a private bounded session lease, no Node, no app preload, denied permissions/downloads/navigation and host-controlled resources. Verify its process is distinct from every other live host/guest before document admission. Only host-owned UI executes in its DOM. Plugin parsing runs in a dedicated worker inside a host-owned opaque-origin frame, with `connect-src 'none'`, bounded host messages and no storage or directory authority. A main-process watchdog can retire only the verified exclusively owned renderer; worker timeouts terminate the worker independently of its event loop.

The main process owns at most eight nonpersistent session slots per application runtime. Reserve a slot before asynchronous policy preparation; admit only its exact lease URL, partition and host. Reserve attachment once and bind one actual guest. Install the pinned minimal viewer preload with Node/subframe/worker integration disabled through the existing guest-admission door. Its emitted bundle must be standalone: a build guard rejects shared chunks, unsupported literal imports/requires, or a missing guarded entry. Type-only imports and the restricted Electron require avoid emitted interoperability helpers. The restricted guest profile cannot register as a browsing page or enter browser routes/auth tracking. A verified, owned rejecting proxy, exact-resource request filtering, denied permissions/downloads, and host-only protocol responses stay in place while a slot is idle.

Retirement withdraws admission immediately, then waits for the actual guest to be destroyed before clearing connections, storage and cache. Reuse keeps the bounded session slot but changes the lease ID/URL. Stale retirement cannot close its successor. Preparation and teardown cannot overlap; failed preparation, guest close or storage cleanup quarantines the slot. Retire host leases on navigation/destruction and include guest/document/session cleanup in the existing bounded application-quit barrier. Native checks prove cookie removal, stale-URL denial, exact preload keys, wrong-renderer/subframe denial, and read/guest revocation after approval is withdrawn. This architecture probe establishes native lifecycle behavior; the separate catalog-installed normal-tab journey establishes UI integration. Cross-platform and remote parity remain unproven.

The native tab surface now uses an explicit `plugin-viewer` editor mode with a publisher-qualified viewer key and strict host-owned viewport state. It never loads a writable editor buffer, including through direct text reload callbacks. “Open with” preserves the original tab, and different viewers cannot collide with that editor or each other. A bounded, validated map retains positions per pane tab; actual non-Git folder split evidence covers source switching, one-pane reload, restart and close. Persisted viewer tabs restore read-only, without a dirty draft, executable state, source bytes or pixel buffers. Main derives the sender, authorizes the opened file through existing desktop roots/user-file rules, and returns only the private attach lease. Native-only admission explicitly refuses SSH/runtime ownership without reading a client-local fallback. The renderer withdraws its lease when its captured owner changes, when the viewer fails or when its pane closes. A verified reopen replaces expired ownership and remounts the parser; stale reopens, late admission and late status cannot revive an old session.

The shipped host assets are standalone browser bundles, including canonical tokens/fonts and existing UI primitives. A trusted relay serves one opaque `allow-scripts` frame, whose host-owned React surface owns sheet selection, bounded row/column virtualization, text paging and canvas orbit/zoom/reset. Author code executes only in the worker. The private preload adds one fixed `notify` method for validated loading/error/viewport status; it cannot select arbitrary IPC channels. Only viewport/status data crosses into the privileged renderer. Canvas pixels stay in the guest. Viewport work is throttled to ten requests per second without waiting for a continuous drag to finish. The native app fixture proves the installed pipeline; it is not an audited spreadsheet parser or the independent binary-format release.

The worker bootstrap hides nested-worker and transport constructors and `importScripts` before loading the separately compiled author script using a private captured importer. Do not concatenate a security prelude and author code: authored hoisted globals could interfere with the prelude before it runs. Author dependencies must be prebundled. Host-owned frame code distinguishes its control/heartbeat messages from wrapped worker payloads; author messages cannot impersonate the main renderer watchdog or supply a document owner.

Worker parsing has an absolute 10-second deadline, each render a 2-second deadline. Independent parent-owned pulses also retire a worker that loops after it reports ready: one unpredictable 128-bit challenge every 250 ms, with one pending reply and a 2-second deadline. Replies do not extend parse/render deadlines. Native tests prove this idle-loop case as well as renderer recovery. Cheap total-attempt accounting is bounded at 1,024 messages/10 seconds, with separate 512-read and 180-control budgets; legitimate bulk reads do not spend the ordinary control allowance. Strict pulse matching and cleanup preserve liveness independently of ordinary traffic. The native coordinator now applies the renderer watchdog before source/file admission. Private-session and byte-transport probes pass. The native installed-parser journey now verifies measured memory retirement of both owned PIDs, worker-loop/flood recovery, a healthy split and targeted API/network denial. Sampled memory and CPU budgets cover all owned renderer processes; 8 sessions and the 16 MiB surface cap bound concurrently accepted current canvas outputs to 128 MiB. These are not hard heap or GPU limits. Packaged/remote parity and broader hostile corpora remain required.

Native probes have verified an infinite guest loop leaves the host responsive and the isolated renderer is retired after roughly 2.25 seconds. They also demonstrate why arbitrary DOM viewers cannot be used here: request blocking, a verified rejecting proxy and DNS opt-out headers do not stop explicit subframe DNS hints. A renderer-only DNS setting protects the top document but not its child. The worker candidate has no DOM, denies nested-worker construction/restoration, blocks an XHR attempt without a resolver job, and terminates a busy worker from the trusted parent. These are architecture probes, not a completed viewer integration or a full network/API audit. General DOM viewers remain unavailable; do not claim an offline iframe boundary or weaken the app's global browser policy to ship them.

Implemented XLSX limits: 50 MiB compressed input, 128 MiB cumulative expanded parts, 10,000 parts, 20 MiB any individual expanded part, 100 sheets, 500,000 populated cells, 10 seconds total parsing, and 1 million rows / 16,384 columns in declared dimensions. Enforce bounds during expansion/parsing, before allocating the whole result. Virtualize rendering separately. Limits reject files with a recoverable explanation rather than promise full spreadsheet fidelity.

Display worksheets, values, useful dates/number formats and cached formula results, clearly labeled. Do not calculate formulas, execute macros, follow external links, save, or invoke native apps inside the plugin. Reject or report unsupported features. Candidate parser reuse requires a fresh code/license/dependency audit; the existing PR descriptions are not that audit. The initial parser comparison now runs the same six workbooks, including three independently produced files, through the bounded adapter and a separate format engine. The incremental implementation can enforce real expansion limits before materializing XML parts; the alternate engine cannot. Broader producer coverage and hostile resource measurements remain release gates.

A hostile parser or guest loop must not freeze Orca. A watchdog on the blocked event loop is insufficient. The native spike is promising; verify the full renderer/worker lifetime, closed API/network boundary, recovery UI and memory behavior in supported packaged clients before public viewer release. Native renderer pooling and sender admission are implemented and tested. Normal-tab rendering and native aggregate process recovery have evidence. Packaged platform parity, resource measurements under broader hostile inputs and remote transport/watch integration remain blocking release work.

The latest change is rebased onto main `8167ddaa`, with all 63 previously staged paths preserved separately from unfinished work. Post-rebase host/desktop checks and the four native journeys below pass on the fresh build. Author validators, schemas and the English kit are regenerated and byte-checked in the new archive. The shipped Spanish release keeps its original reviewed hashes: eight translations are stale against the updated source and fall back to English until reviewed; generation does not approve them.

### Paired-runtime viewers: host authority and pinned desktop transport

The host registers strict, negotiated `files.pluginViewer.open/read/close/observe` methods behind `files.plugin-viewer-document.v1`. The real runtime file-command surface owns the registry. Its boundary comes from the host's currently registered workspace, including non-Git folder workspaces; serialized owner fields cannot select a socket or authorize another path. Admission pins runtime identity, workspace/root and live catalog owner. Every bounded range rechecks those owners and the regular-file revision. Positive catalog ownership rejects the older resolver's unowned-workspace local fallback, even when a cached path survives removal. Two unresolved openings stay counted through cancellation, and eight live leases are bounded and reclaimed on real socket cleanup.

The desktop now holds one dedicated authenticated connection per document. It checks answering runtime identity and capability on that socket before admission, keeps idle leases connected, and permanently retires the connection on close, abort or socket loss. Requests never reopen or replay that lease. Main-process authority pins the saved environment id, pairing revision, pairing credentials and transport generation, and requires the exact native owner/file identity. The actual disconnect/re-pair lifecycle invalidates the guest. Explicit Reload recaptures the same owner's current connection; a pairing rotation must be proven to continue the same host. An unproved same-id re-pair or missing original pairing requires workspace reopen. Ordinary cached control connections retain their existing 60-second idle-close behavior.

Actual E2EE/Store tests cover binary ranges in folder repositories and non-Git folder workspaces, sibling socket/client isolation, real disconnect cleanup and reservation recovery, capability/mobile denial, replacement/symlink/traversal refusal and admission cancellation. Dedicated-client tests cover idle retention, actual socket loss without reopen, wrong answering runtime, cancellation and mutation. Desktop authority tests use the real environment store and encrypted runtime but mock managed-tunnel preparation; they do not prove managed-tunnel startup. The final source-built native macOS journey uses a separate headless serve process, catalog-installed XLSX/STL, Git Explorer, producer content and actual canvas pixels, damaged-file repair/Retry, old guest destruction, reconnect without resurrection, explicit Reload and an actual non-Git folder workspace. This loopback topology shares an operating system and does not prove remote-only paths.

The real lease and connection tests explicitly run on Node, matching Electron. The final combined results below include the subsequent nested-host authority and lifecycle notification changes.

The dedicated viewer socket also carries one authenticated lifecycle observer per document. Host retirement completes that exact lease’s stream; idle parsed guests close immediately on nested SSH disconnect. Notifications pin the established request ID, lease UUID and answering runtime; malformed or foreign identities in that stream fail closed. Observer duplication is denied without cancelling the original. Disconnect/cancellation releases the listener and handle. There is no periodic document polling and no automatic replay on a replacement socket.

Nested SSH Git admission verifies the actual selected server-side Git provider’s worktree list before bytes are opened. This avoids inheriting the general resolver’s saved-metadata fallback as viewer authorization. Provider replacement during lookup is refused; replacement after admission invalidates reads. Ordinary registered folders require no Git lookup.

Four hidden native journeys pass together in about 1.3 minutes: first-class catalog (5.6 seconds), desktop → paired runtime → disposable Linux OpenSSH (22.4 seconds), desktop → headless serve host (27.9 seconds), and direct OpenSSH (19.0 seconds). The nested journey proves remote-only XLSX/STL, repair/Retry, idle guest retirement on actual host-side disconnect, no automatic resurrection, explicit Reload and a separate non-Git folder. Its file paths do not exist on the desktop; the desktop probe records no direct SSH attempts. All owned applications and disposable fixtures close in finally blocks. The folder fixture waits for actual terminal PTY binding before file opening because the existing terminal-startup flow can otherwise steal focus.

Current expanded regression: 1,733 passing tests across 188 files, including actual encrypted lease/observer clients, strict notification failures, SSH provider and relay byte lanes, Electron isolation, renderer owner/reload and CI Node boundaries. All seven current changed-code gates pass across 557 files. Production Node/web typing, generated RPC catalog and author snapshots pass. The last broad optional E2E typecheck failed with 647 diagnostics. It is not globally passing and was not rerun for this selection change; production Node/web checks pass.

### Actual managed server startup

A separate hidden native journey deploys the branch-built server template through actual OpenSSH to Linux arm64, starts the hash-pinned Node 24.21.0 runtime, then opens remote-only XLSX and STL from ordinary Explorer. The real patched node-pty N-API 8 slot is compiled on the glibc 2.28 image and passes the native symbol-floor gate. The one-target template passes its checksum verifier. It is retained locally for this integration; no complete release-template, publication or signed/package platform proof is claimed.

The initial real journey found that the renderer catalog could still have a null runtime ID after the host's verified status arrived. Viewer admission now reads the current pairing-bound status, rejects retired/blocked/foreign/stale-pairing snapshots and preserves the dedicated authenticated socket's identity check. It does not rewrite saved authority or infer identity from an endpoint. Six focused identity cases and the actual React admission/cleanup tests pass.

The refreshed five-journey native run passes in 1.9 minutes: catalog 6.1 seconds, managed startup 25.5 seconds, paired-runtime nested SSH 24.1 seconds, headless paired host 30.6 seconds, and direct SSH 21.0 seconds. The managed journey proves producer workbook content, actual STL canvas pixel, damaged-byte repair/Retry, exact guest destruction on disconnect, no automatic resurrection, explicit Reload, and an independently registered non-Git remote folder. All three file paths are absent on the desktop. Every window stays hidden and exact owned profiles/processes/containers close in finally blocks. Its dedicated Docker CI lane builds the required server template; source selection and allocation checks prevent a silent skip. Actual macOS desktop → Linux server is the tested topology.

Remaining runtime delivery gates: Windows/WSL, ordinary out-of-workspace file-selection UX and native proof, file-watch lifecycle, and packaged runtime parity. Hosts missing the negotiated document capability fail closed. The earlier unsigned macOS production package is a verified checkpoint that predates these runtime additions. This evidence does not complete the full phase release gate.

### Host-issued selections for runtime files

The runtime now negotiates a separate `files.plugin-viewer-selection.v1` capability. `files.pluginViewer.select` requires the paired desktop's existing **host-admin** authority, actual runtime client kind and both viewer capabilities. Mobile and remote SSH CLI callers cannot mint these grants. The ordinary workspace-permission open method still rejects outside paths; a serialized `user-file` flag is not authorization on that wire.

Selection resolves the actual registered workspace and execution host, opens one regular-file handle through the existing canonical reader and returns a 30-second opaque grant. That grant binds the actual socket and client credential, runtime, lease, workspace, tab, plugin identity/generation and exact file path. Open consumes it once on the same authenticated socket, verifies the selected handle's revision again, then transfers ownership to the document lease. Another socket, file or owner cannot borrow it. The grant never reaches the parser SDK. Consuming ends the short selection deadline; the document's ordinary authority and socket lifetime govern subsequent reads.

Pending selections and live documents share the two-opening/eight-file admission budget. Cancellation retains unresolved work in that budget until settlement. Expiry, disconnect and disposal close unconsumed handles; consumed handles follow normal document retirement. Cleanup transfer uses the existing subscription registry's actual cleanup semantics, with one owner throughout.

Real-file and encrypted runtime tests cover outside binary ranges, one-use transfer, wrong socket/credential/owner/file, mutation/replacement/symlink changes, expiry, actual socket cleanup, shared capacity and cancelled unresolved admissions. The dedicated client and main-process route select and open on one verified socket, including registered non-Git folders. A simulated missing selection capability fails before either method is issued; this is not an older-binary claim. Actual selected documents remain readable after 61 seconds, beyond both the grant deadline and ordinary connection-cache idle deadline. Main-route tests use real Store/E2EE but mock managed-tunnel preparation. The ordinary new-tab path field now offers **Open file · Read only** for a positively owned remote workspace. Its action carries the displayed owner generation and refuses a changed owner instead of reinterpreting the path on another host. Host path syntax governs validation. A persisted selected-file marker retains intent, never grants or sockets; ordinary editor read/write access is unchanged. Core viewer choice and core defaults cannot turn that tab into an editor. Metadata loading uses the existing waiting tab; missing viewers remain in the chooser. Actual paired-host STL and nested Linux XLSX paths outside their workspace roots pass typed-input, rendered-byte, disconnect and explicit-Reload journeys. The Linux selected path is absent on the desktop. The final native run also proves selected-file opening from a registered non-Git runtime folder and direct SSH; the direct selected workbook survives a fresh connection generation only after explicit Reload. A regression found and fixed a Git-only provenance check that excluded positively pinned folders. Further empty-viewer recovery UX and restart/platform qualification remain separate release work.

## 8. Directory and user flows

Start from the existing catalog chrome/components and follow the style guide, canonical tokens and shadcn primitives. No new visual system.

```text
Plugins                         [All] [Installed]     [Sources]
[Search name, publisher, locale or file type…]        [Cards | Split]
[All types] [Interface languages] [Coding languages] [File viewers] [Appearance]

[preview]  Portuguese (Brazil)   [Bundled / Official / Community]
           Interface language · current coverage · compatible
           [Install / Use language / Review update]
```

Cards provide preview, name, publisher, category, compatibility and one action. Split view puts list/filters beside detail. Detail contains pack-specific sample, version/source, current eligible translation coverage or supported format features, release maintenance information, checked revision, execution explanation and license. Installed/enabled/selected are distinct states. Visual design stays quiet; source/trust information is readable without dominating discovery.

- **Data install:** inspect source/type in the detail → Install → validated data becomes enabled → Use language if relevant. The Install click is explicit consent to data; no worker-permission dialog. Never auto-switch locale.
- **Viewer install:** Install → host review of UI execution and opened-file reading → Enable → open a matching file. Safe default in the review is Keep disabled.
- **Update:** show installed/candidate versions and source; routine valid data uses Update, changed authority uses Review update. Decline leaves the old verified release usable where safe.

The native catalog now has a separate reviewed v2 update transaction. Its preview names the installed version and offers Keep current version or Approve and update; review itself leaves the installed pointer and approval unchanged. The main process snapshots the exact preview receipt, rechecks commit/hash/source, and checks the original current pointer inside the serialized installer. Publication records approval only for those reviewed bytes, preserves disabled choices, and restores pointer, source index and prior consent if saving approval fails. Ordinary catalog installation cannot bypass this update review. Same-byte source rebinding cannot rewrite immutable provenance; publish a new release. Full instruction review, legacy/local/Git/headless parity and abrupt-crash recovery remain integration gates. A fresh native viewer journey verifies review, cancellation with the old guest still usable, approval, withdrawal of the old guest, saved-camera recovery and changed parser output from the replacement release.

- **Disable/remove:** reconcile effective locale/syntax and open tabs immediately. A missing viewer displays a host-owned alternative/close action. Removing bundled data uses disable/restore semantics; it must not corrupt app resources.
- **Offline:** installed/bundled packages remain usable; show cached catalog state and retry for network operations.

Public directory and app use the same versioned catalog data; installed state is a private local overlay. Public actions expose exact source/version and Copy source/Open instructions initially, using the existing in-app source installer. Do not make a new application deep-link protocol or shell-command copy a prerequisite. Listings/checks apply to exact release commits, not mutable upstream branches; “validated” and “reviewed” are separate facts, not universal safety badges.

The independent static directory now builds from an explicit validated v2 catalog and its Git source/ref. It shares the app's filters, core UI primitives and canonical theme tokens, with literal previews, full release metadata, supported install instructions, light/dark modes, mobile layouts, keyboard/focus/IME behavior and cached-metadata recovery. Seven production-browser journeys pass against the actual Git/catalog fixture cohort; screenshots distinguish browser evidence from native installation evidence. See [the concrete directory contract](phase-o-1-directory.md). External publication and completed hosted platform CI remain delivery checks.

## 9. Sources, repository ownership and releases

Use `stablyai/orca-plugins` as the small official catalog, separate package repos such as `orca-plugin-locale-pt-br`, `orca-plugin-syntax-typst`, `orca-plugin-viewer-xlsx`, and shared tooling in `orca-plugin-tooling`. Package identity remains `stablyai.orca-…`; community authors use their own publisher and repository/provider. These are proposed names, not repositories created here.

Extend the marketplace to a versioned v2 catalog so old hosts do not silently ignore release checks. Each listing declares identity, supported contribution types, source URL/ref, version, expected commit, expected content hash, compatibility and contained preview/metadata. Fetch/resolve the named tag and compare the actual commit/hash before publication. A changed tag must fail, not become an unnoticed new release. Follow system-Git credentials and Git 2.25/SSH host compatibility.

Git download and preview never check out author content. The host disables template copying, checkout hooks, submodule recursion and automatic maintenance while downloading, then reads exact blobs through baseline-compatible `ls-tree -r -t -l -z --full-tree` and `cat-file --batch`. System-Git credentials and SSH configuration still work. This prevents attributes from selecting a configured executable filter before approval and keeps release hashes independent of `core.autocrlf` or `eol` settings. Trees are validated before blob allocation: 2,000 entries including directories, 50 MiB logical file bytes, 1,024 UTF-8 bytes per relative path and depth 64. Symlinks, submodules, unsafe/reserved paths, metadata aliases, case/Unicode collisions and inconsistent parents are rejected. Batch output has bounded allocation and exact object/size/framing checks. The external Git transport is not a hard disk/network budget; those extraction limits do not bound a compressed pack downloaded before inspection. Git LFS pointers are not resolved.

Real configured-filter and global/template-hook fixtures distinguish ordinary checkout from script-free extraction. Tag, default-branch and exact-commit downloads retain identical text and binary hashes. The new command contract passes a locally compiled Git 2.25.5 binary and the current system Git; these focused results are separate from completed hosted platform CI. [Git 2.25 tree format](https://raw.githubusercontent.com/git/git/v2.25.0/Documentation/git-ls-tree.txt) and [raw batch blobs](https://raw.githubusercontent.com/git/git/v2.25.0/Documentation/git-cat-file.txt) document the baseline commands.

CI uses a pinned shared schema/validator, drift/corpus checks, package license/provenance checks, and prebuilt artifact verification. Public JSON schema/examples are generated from the runtime definition. A published release tag owns its artifact bytes; releases do not require runtime dependency installation. Build jobs/secrets are separate from untrusted contributor checks.

Maintainer loop: template → author → validate → preview → version/tag prebuilt output → catalog PR → independent package updates. Community authors can submit to official packages or maintain their own listings. Opt-in translation-refresh automation can propose a PR; no automatic publication or changed-authority approval.

The independent author package now provides three templates through `orca-plugin init`, plus `validate`, `catalog export`, `catalog diff`, `pack`, `inspect`, `locale export` and `locale diff`. These are author-tooling commands, separate from the public Orca application CLI. Generated runtime/schemas reuse the host definitions; template CI vendors a fixed offline validator. A viewer template includes the public SDK, locked build tools, prebuilt output and fixtures. Data profiles and changed/unsafe release files have rejection tests. The actual npm archive creates all three examples outside the core checkout; local commit/tag packaging and catalog export produce matching host hashes. A native community-source journey installs all three templates, applies a real translation, colors a file and opens the approved viewer. Publication/name ownership and actual platform CI remain gates. See [the concrete maintainer workflow](phase-o-1-maintainers.md). Dev mode uses the same classifier and refresh/reconsent lifecycle as installed releases.

## 10. Implementation slices

Each row should become a reviewable change with its gate. Execute dependency order; parser/grammar/isolation probes can proceed while catalog work is built. No calendar estimate until probes settle the risky seams.

| Slice                            | Concrete work / existing seams                                                                                 | Exit gate                                                                                                                          |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| O1-01 Profiles and compatibility | Manifest v2/classifier; consent source/execution boundary; installer and dev discovery; preserve the panel fix | Misclassified/unknown manifests rejected; all promotions/stale reviews blocked; legacy data/panel behavior documented              |
| O1-02 Release/tooling contract   | Catalog v2, exact commit/hash enforcement, shared generated schema, three templates                            | Moved tag/source mismatch fails; independent author can validate/package without core edits                                        |
| O1-03 Bundled data path          | Bootstrap/startup composition, immutable snapshot selection, third-party-off semantics                         | One existing locale and grammar work offline with verified bundle integrity                                                        |
| O1-04 Locale maintenance         | Artifact envelope/export/diff, runtime validation/fallback, main/renderer loaders                              | Source changed without key rename becomes stale; plural/placeholder/protected copy tests pass                                      |
| O1-05 Grammar isolation spike    | Host worker + supported editor tokenization adapter, disposal/model-version protocol                           | Host stays responsive under hostile regex; multiline retokenization demonstrated; otherwise do not proceed to public grammar packs |
| O1-06 Syntax contribution        | New manifest fields/artifacts, registry, language detection, disposables                                       | Two independent packs update/remove on open local/SSH/folder models with no stale resurrection                                     |
| O1-07 Viewer/isolation spike     | Session-authorized provider read, prototype tab/byte lane, actual sandbox parser and hostile UI                | XLSX bytes reach an isolated cancellable parser locally/SSH; host recovery demonstrated in packaged targets                        |
| O1-08 General viewer API         | Viewer resolver/tab lifecycle, revision/watch, budgets, owner revocation, remote fallbacks                     | Cross-session/path/race/flood tests pass; old-host states work; no file is modified                                                |
| O1-09 Format packages            | Audited XLSX implementation plus independent binary viewer                                                     | Same general API, real fixture corpus, limits, disable/disconnect/restore checks                                                   |
| O1-10 Catalog/user journey       | Cards/split/detail, search/categories, installed states, review/fallback actions; static public directory      | Clean-profile install/use/update flows pass keyboard and visual validation                                                         |
| O1-11 Cohort release             | Package/app upgrade matrix, release resources and author docs                                                  | Maintainers update independently; exact supported platform/client/host matrix published                                            |

Concrete source seams include [manifest validation](../../src/shared/plugins/plugin-manifest.ts), [content registries](../../src/main/plugins/plugin-content-pack-registry.ts), [bundled bootstrap](../../src/main/plugins/plugin-bundled-bootstrap.ts), [startup composition](../../src/main/startup/main-process-plugins.ts), [locale artifacts](../../src/shared/plugins/plugin-language-pack-artifact.ts), [grammar registration](../../src/renderer/src/lib/monaco-languages/textmate-language-registration.ts), [file detection](../../src/renderer/src/lib/language-detect.ts), [filesystem contract](../../src/main/providers/filesystem-provider-contract.ts), [authorized preview reading](../../src/shared/doc-preview-file-access.ts), [panel shell](../../src/shared/plugins/plugin-panel-shell.ts), and [catalog chrome](../../src/renderer/src/components/plugin-catalog/PluginCatalogLayout.tsx). New modules should be named for these domains, not generic helper folders.

## 11. Acceptance and unresolved blockers

Phase complete means all cohort packages work through the same real installation/update/removal paths, one app upgrade and one package upgrade have been exercised, and independent maintainers can follow the tooling guide. Require:

- P0 providers expose all six lifecycle actions for declared lifetimes, keep account/source and credentials on the selected host, preserve history on disablement or loss of contact, require fresh endpoint/authority review, and connect through Orca’s real SSH/managed-server path. Interrupted mutations remain unverifiable until an authoritative receipt resolves them; no blind replay.
- Data profiles cannot run code or gain execution through an unreviewed manifest/update; pending candidates never load themselves to justify approval. Legacy panel migration and stale dialogs remain covered.
- Locale drift/plurals, bundled offline defaults and third-party-off behavior pass through actual main/renderer consumers.
- Slow grammar, lazy-load races, disposal and hostile UI/format data preserve typing and tab close; packaged recovery is measured.
- File authority tests cover traversal/symlinks, wrong owner/host, stale revisions, sibling reads, disconnect, disable, removal and revocation. Transfer/expansion/concurrency limits apply before expensive allocation.
- Local Git/folder and SSH Git/folder flows work on supported desktop platforms. Old-host and unsupported-client behavior is explicit; no blanket remote parity claim.
- Directory actions, disabled/incompatible/pending states, keyboard navigation and meaningful previews pass running-app validation. Public listing and installed release refer to the same exact source.

The editor uses a supported cached-token integration, now wired to catalog-installed syntax packages. The initial bundled locale/grammar migration works locally; application-upgrade, client/host matrix, broader combined diff failures, packaged viewport/Undo and platform lifecycle gates still apply. Native viewer UI isolation/recovery and normal-tab integration now have evidence. The native aggregate resource policy and initial parser comparison now have evidence; additional packaged platform/host measurements, broader corpus/security review and Windows/WSL and packaged runtime parity remain unresolved gates. Their evidence lands before dependent APIs; do not substitute optimistic declarations or silently drop a priority to call the phase done.

Numeric limits above define concrete release defaults. Several already have schema, allocation or runtime enforcement; remaining implementations and packaged/remote measurements must meet the same contract. Validate them with representative fixtures, document any adjustment before API freeze, and enforce them centrally. They do not promise that every large workbook can be rendered.


## Viewer acquisition checkpoint · 2026-10-08

The ordinary selected-file tab now offers **Browse file viewers** when no installed viewer matches. It opens Plugins with the File viewers category selected and preserves the source tab. The existing opt-in switch retains that category. Metadata failures offer Retry and discovery without promising an unavailable core fallback; unsupported or unresolved owners retain their connection explanation. Missing saved defaults are preserved. Open with also offers the catalog route and closes its picker state correctly.

The actual paired-host native journey proves no-viewer recovery, feature opt-in, category filtering, real pinned Git install, separate execution approval, Escape back, Open with and explicit Open once. The selected producer workbook renders in the original visible tab and pane with its owner and read-only marker intact. Changing renderer mode intentionally migrates the file entity ID; the native assertion checks the actual tab identity. Browsing from the installed viewer also returns to an interactive guest. Its final fixture waits for the whole closing popover to leave the DOM, then verifies terminal view and hidden Settings; screenshot review caught an earlier retained-guest visibility check that did not prove foreground navigation. Six new actual captures are embedded in the local report.

Current validation: **1,733 tests / 188 files**, production Node/web typing, **seven gates / 557 JS/TS files**, generated author snapshots and **19 independent author tests**. An initial regression worker exited with SIGTRAP; its 13-case suite and the final complete rerun passed. Four unchanged native journeys passed on the final source build; the acquisition journey passed a targeted rerun after the fixture waited for the closing picker to disappear before sending Escape. The full-run result was four passing and one failing before that fixture correction; it is not described as a single five-pass run.

Current compiled build: 1,601 regular main/preload/renderer files, composite SHA256 `faee6b6e9c953c3b64dbe1c88da1d91407a32ab5532d9cae1ecb6614faa75d45`. The refreshed 39-file author archive exactly matches source: 1,090,645 bytes, SHA256 `83c356121b1362e2eb1a8980c35af0e4bc1109dd3280063c2c2143c9765c7378`. Included translation review hashes were preserved. This checkpoint reuses the verified Linux server template; it changes desktop recovery UI and English/tooling data, not host grant behavior. Exact logs, source hashes and report QA are recorded in `.tmp/phase-o-1/evidence/viewer-catalog-recovery-native-evidence.json`.

Prior-app upgrades, broader update/crash and Git transport qualification, Windows/WSL, additional packaged platforms and final security/repository review remain release gates. No PR has been created.

## Selected-file restart checkpoint · 2026-10-09

The actual paired-host/non-Git-folder journey now quits and relaunches the desktop twice against one profile and pairing. An outside workbook is replaced on disk while the app is closed. Its qualified viewer, visible tab, pane, positively pinned runtime owner and read-only intent restore; a new native guest reads current **Team budget** contents. A conflicting saved core association cannot make the core editor eligible. Session persistence excludes grants, leases, sockets, credentials and operation provenance.

Source inspection found two handoff omissions. Admission captured fresh owner provenance but selected-file access still read the persisted snapshot without it; the helper now receives that captured provenance. Successful admission also retains that verified owner in memory for subsequent explicit Reload. The real disconnect retires the restored guest, reconnect creates no guest, and Reload reacquires current file access. Disabling the installed viewer persists through a second restart without a guest; enabling through Settings and explicit Reload recover the same file. The re-pairing refusal rules remain unchanged. Five new actual native captures are embedded in the report; the intermediate loading/admission diagnostic is retained separately and is not presented as a completed feature.

Current checks: **1,735 tests / 188 files**, **25 focused lifecycle/access/reload cases**, production Node/web typing and **seven quality gates / 559 changed JS/TS files**. The new native restart journey passes in **28.6s** (29.9s runner). Four existing native journeys pass on the same build: catalog **5.7s**, nested SSH **22.5s**, paired runtime/acquisition **32.5s**, direct SSH **19.0s**. Managed startup initially failed when its observer read a guest before `document.body` existed; the corrected observer returns pending text until the DOM exists, and its targeted rerun passes in **21.7s** (22.7s runner). This is combined qualification, not a single six-pass result. The earlier two failed restart attempts remain recorded separately. The optional broad E2E typecheck still fails with 648 diagnostics; the new restart helper/spec and managed-viewer spec have none. This is not a passing global typecheck.

Current source-built desktop: **1,601 regular files**, SHA256 `fff948801e9cdb9dafc1263fba58a74b12df2c74bc07804c7cbb78d18487d4e9`. The Linux host template and author archive are reused from their prior verified checkpoints; no host or author-tooling behavior changes in this fix. The source/build/log/capture records are in `.tmp/phase-o-1/evidence/selected-file-restart-native-evidence.json`. The standalone report contains **173 actual images**.

This settles the selected-file development restart gate. Real prior-app upgrade, broader update/crash and transport-resource qualification, Windows/WSL, additional current production-package/platform proof and final security/readiness/repository review remain required. No PR, push or publication has been made.

## Real prior-binary upgrade and refreshed production package · 2026-10-09

The actual signed macOS arm64 **1.4.212** release launches with an isolated profile and hidden windows. Its real Appearance controls save **Spanish and dark mode**; its native menu changes to Spanish. The official archive digest and bundle signature were verified before launch. The freshly built production **1.4.214** package then opens the same profile, without a renderer store hook, and preserves those preferences with optional plugins off. The new feature-introduction dialog is dismissed through its actual close control; the test does not rewrite the old profile to hide upgrade behavior.

Included Spanish and Typst are enabled data snapshots. Disabling Spanish restores the English native menu while retaining `uiLanguage: es`; enabling it restores Spanish. Ordinary Explorer in a non-Git folder opens a real Typst file with multiple visible token colors. A second current-package launch restores the file, colors and preferences. The passing identity receipt records all three actual packaged launches against one user-data path. This is a real binary upgrade, distinct from the older saved-settings simulation.

The refreshed package also installs and reviews XLSX/STL from pinned Git, opens both actual formats, highlights an installed grammar, repairs malformed workbook bytes through Retry and restores the workbook after restart. Separate native traces identify each dedicated parser worker and its owned child-frame process. Sampled STL/XLSX aggregates are **303.5/309.4 MiB** and **0.285/0.279 CPU seconds**; these small-corpus observations are not hard resource ceilings.

The repeated recovery journey passes all six cycles: memory growth, idle infinite loop and invalid-message flooding, twice each. Both owned native PIDs retire in every cycle; Settings remains usable and Retry creates a fresh working document. Sampled memory peaks are **996.2/931.6 MiB**, reflecting overshoot of the sampled policy. Its first refreshed run reached memory retirement but failed because an unrelated usage-tip card intercepted Settings; the fixture now dismisses that real card through its normal UI. No product behavior changed for this qualification.

Qualification is combined: the full three-test run passed packaged formats (**14.7s**) and real upgrade (**11.5s**), and failed parser recovery (**38.3s**). Corrected recovery passed its targeted rerun (**25.6s**, 26.3s runner). It is not a single three-pass run. Two earlier upgrade attempts failed on fixture radio/navigation assumptions; their logs remain separate. Seven quality gates pass across **560 JS/TS files**. The optional broad E2E typecheck still fails with **648 diagnostics**, with none in the new upgrade spec; it is not a passing global gate. The prior **1,735-test** source regression and production typing remain the unchanged-product checkpoint.

Actual package inspection verifies **1,413 main/preload/renderer files** against the production build and **33 bundled-resource files** against source. Scratch files, independent author sources and public-directory output are absent from `app.asar`. The optional managed-runtime template was not included; this does not establish full release-template or remote-package parity. Seven new actual captures plus the twelve refreshed package captures appear in the **180-image** standalone report. Artifact/source/log/capture hashes and browser QA are recorded in `.tmp/phase-o-1/evidence/prior-app-upgrade-native-evidence.json`.

Scope: signed prior binary to unsigned current directory package, macOS arm64, local non-Git folder files and preference migration. No installer, notarization, updater-install/rollback, packaged remote-host, Windows/WSL or Linux-desktop claim. Broader upgrade/crash, Git transport resources, platform/host qualification and final security/readiness/repository review remain required. No PR, push or publication has been made.

## Production package with a direct Linux SSH host · 2026-10-09

The same current unsigned macOS arm64 production package now passes a separate actual OpenSSH journey against a disposable Linux host. It uses `app.asar`, has no renderer store hook and keeps native windows hidden. Normal catalog installation and execution review precede all document access. Host setup uses the public SSH/project-group/folder APIs; ordinary sidebar selection and Explorer open the documents. The registered folder has no `.git`, and all three remote paths are absent on the desktop.

The installed XLSX viewer renders a real producer workbook, shows damaged-byte failure after Reload, and recovers repaired host bytes through Retry. The independently installed STL viewer renders its actual checked canvas pixel through the same document API. The ordinary new-tab path field opens an outside workbook with read-only intent. Actual SSH disconnect destroys every old private viewer guest; reconnect changes the connection generation and creates no guest. Explicit Reload opens a fresh session with the real workbook content. Seven new actual captures record these states.

The journey passes in **15.7s** (**21.0s runner**, including Docker preparation). The final source adds required braces after the passing run; assertions, control flow and package bytes are unchanged. Seven quality gates pass across **561 JS/TS files**. The broad E2E typecheck remains failed with **648 diagnostics**, with none in the new packaged-SSH spec. Current production Node/web typing is passing. The prior 1,735-test unchanged-product regression still supplies the source checkpoint; no product implementation changed in this qualification.

The report now contains **187 actual images**. Its standalone embedded images, source/package/log hashes and desktop/mobile/zoom checks are recorded in `.tmp/phase-o-1/evidence/packaged-ssh-native-evidence.json`. This qualifies the production desktop with direct Linux SSH and registered non-Git folders. It does not qualify a production paired/managed runtime, Windows/WSL, Linux desktop, installers, updater rollback or all hostile combinations. The optional managed-runtime template remains absent from this package. Broader host/platform, transport-resource and final security/readiness/repository gates remain open; no PR, push or publication has been made.


## Exact Git repository formats and CI qualification · 2026-10-09

Real reproduction found that tagged SHA-256 downloads worked while exact pinned SHA-256 commits failed: the staging repository used SHA-1. Staging now explicitly selects SHA-256 for 64-character commits; ordinary SHA-1 initialization retains the Git 2.25 path. An inherited `GIT_DEFAULT_HASH=sha256` cannot change a SHA-1 installation. The existing execution-host capability cache coalesces unsupported probes, skips later known-invalid commands and preserves transient failures. Unsupported hosts get an update/retry explanation; native and WSL cache identities stay isolated. No checkout filters, author hooks, scripts or submodules are introduced.

Current source regression: **1,808 tests / 193 files**, including six new capability/lifetime cases and eleven narrow unsupported-error cases. Real Git 2.25.5 and 2.55.0 each pass the 30-case binary contract. The added 2.29.0 lane passes all four contract files locally: **43 passed / two existing version-gated skips**. CI builds the pinned, checksum-verified boundary binary through the existing cache action.

A fresh production build and unsigned macOS arm64 directory package contain 1,413 matching compiled files and 33 matching included-resource files. The actual packaged catalog journey passes in **6.1s (7.0s runner)**: it discovers a SHA-256 catalog, shows the exact 64-character language release, installs it through the normal data action, verifies the installed commit/content hash through public IPC, and applies its native-menu translations through Use language. The installed language has no worker. All windows remain hidden and no renderer store hook is available. Three actual captures and the sanitized app/install identity receipt record this result.

The broader regression found that the packaged SSH spec had no CI lane. The Linux package job now explicitly runs the Git, format/restart, repeated parser-recovery and SSH journeys against its own production executable under Xvfb, with evidence upload. The selection contract checks actual runner reachability and package-only changes trigger packaging. Hosted Linux results are pending; configuring a lane is not a platform pass.

Production Node/web typing passes. The optional broad E2E check still fails with **644 diagnostics**, with none in the new Git journey or its catalog fixture/release helpers after checked union narrowing and explicit fixture environment typing. Other owned plugin/helper diagnostics remain; the global gate is not passing. Exact logs, package/source digests, captures and report QA are recorded in `.tmp/phase-o-1/evidence/git-object-format-native-evidence.json`.

The standalone report retains prior upgrade/SSH/restart checkpoints and adds the three new Git captures. Hard Git download-disk/network ceilings, broader update/rollback/crash and platform/host qualification, and final security/repository review remain open. No PR or publication was created.
