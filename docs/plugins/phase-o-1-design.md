# phase-o-1 · Release blueprint

_2026-10-09. Accepted design for this phase. Implementation remains in progress; the [full contract and evidence](phase-o-1.md) track what has actually passed. This blueprint takes precedence over older proposals._

## What the user gets

One place to discover, install, update and manage plugins. Start with three families, using the same source, identity, release and approval system:

| Family                  | First release                                                       | Typical journey              |
| ----------------------- | ------------------------------------------------------------------- | ---------------------------- |
| Interface languages     | A community locale; included Spanish through the data-plugin path   | Install → Use language       |
| Coding-language syntax  | Two independent grammar packs; included Typst through the same path | Install → open matching file |
| Additional file formats | A general read-only viewer API, proven by XLSX and binary STL       | Install → Review → open file |

XLSX is a proof of the generic format extension point. A new format must require a package, not a format-specific branch in Orca. Saving documents, language servers and native converters are outside this phase.

Existing appearance and experimental panel functionality stays available. Future task systems, sidebars, agents and other families reuse package identity, distribution and approvals; each gets its own domain API when needed. Do not expose a universal app-object or arbitrary IPC bridge now.

## Decisions for phase-o-1

| Decision                  | Concrete outcome                                                                                                                                          |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start small               | Three author templates: locale, syntax and file viewer. Ship a community locale, two independent syntax packs, XLSX and binary STL viewers                |
| One package system        | All families use the same qualified identity, strict manifest, compatibility checks, exact releases, installation and approval storage                    |
| Separate domain contracts | Locale resources, syntax registrations and document sessions have distinct APIs and lifetimes; installing a locale never creates a worker                 |
| Data is enforced          | Locale/syntax-only packages use `data`. Any added execution must declare the corresponding profile, validate and receive fresh review before activation   |
| Explicit updates          | Check for updates and review/install deliberately. No unattended update or dependency installation in this phase                                          |
| Included packages first   | Prove one included locale and grammar. Keep English and Plain text available for recovery. Moving every language follows successful upgrade qualification |
| Independent ownership     | One repo per independently released package, one catalog repo and shared tooling. Community packages can use other Git providers                          |
| Future growth             | Preserve the shared foundations; defer task-provider, sidebar and agent contracts until their actual permission and lifecycle needs are known             |

The public API remains experimental until the cohort passes its acceptance gates. The minimum supported Orca version is recorded in each release, rather than promising that an older experimental host can safely ignore new fields.

## The catalog is a product surface

The app and public website consume the same versioned catalog. Only the app adds private installed state and activates packages. Use Orca's documented components, typography and theme tokens.

```text
Plugins              Browse | Installed | Sources
Search name, publisher, language or file type…
All | Interface languages | Coding languages | File viewers | Appearance
Cards | Split view

Preview   Name · Publisher · Version
          What it adds · Compatible / Requires newer Orca
          Install / Use language / Review update
```

Cards show useful previews: translated interface text, colored sample code or a representative file-viewer surface. Selecting a card opens details with the supported features, source, license, exact release, compatibility and execution explanation. Publisher previews are inert data.

Keep **installed**, **enabled** and **selected** distinct. Installing a locale does not switch the app's language. File defaults change only through an explicit choice. Existing core previews keep precedence unless the user chooses otherwise. Multiple eligible viewers use Open with; a missing or disabled viewer offers an alternative without changing the file.

Every asynchronous flow has loading, success, empty and recoverable error states. Search survives refresh failures; cached catalog metadata is labeled stale. Keyboard navigation, Escape, focus restoration, light/dark themes and narrow layouts are release criteria. The website initially offers copyable catalog-source instructions; it must not require a new deep-link protocol or a shell command.

### File-to-catalog recovery

| File state                                 | Action and resulting state                                                                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| No installed viewer                        | **Browse file viewers** opens Plugins with the File viewers category selected; the source tab stays open                                  |
| Plugin system off                          | The same route exposes the existing opt-in switch; enabling it retains the category                                                       |
| Missing or disabled saved viewer           | Preserve the default, offer Retry, Open with and catalog recovery; installing does not rewrite the association                            |
| Metadata failed                            | Show an inline error with Retry and catalog recovery; offer core fallback only where the file's authority permits it                      |
| Unresolved owner or unsupported connection | Explain the actual connection state; do not suggest that installing a viewer will resolve host support                                    |
| Install completed                          | Return to the same file with Escape/Back, choose an installed viewer and **Open once**; defaults still require a separate explicit choice |

Open with also provides the catalog route. Category selection is renderer-only navigation state; browsing and installing do not mint document access. The actual file-open transaction rechecks the owner and obtains its host-issued lease.

### Four complete user journeys

1. **A new interface language:** Browse → Interface languages → inspect translated sample and freshness → Install → Use language. The current language stays selected until the final action. Disable restores English or the included fallback while retaining the saved package preference.
2. **A coding language:** Browse → Coding languages → inspect sample and supported extensions → Install → open a matching file. Preserve core precedence; conflicting eligible grammars require an explicit association choice. Disable/update removes old registrations and preserves the document's edits and Undo.
3. **An unfamiliar file:** open file → Browse file viewers if needed → inspect supported formats → Install → review opened-file execution/access → return to the original tab → Open once. “Always use” is a separate action. A parser error offers Reload, Open with or Close.
4. **A package gains authority:** Review update shows installed and candidate versions, source and added execution. Keep current version leaves the verified release usable. Approve and update applies only the exact reviewed candidate; a changed candidate requires a new review.

Routine data installation uses the Install action as consent; it adds no execution dialog. Execution review uses plain language such as “Runs an isolated parser to read files you open.” Full-trust workers need a stronger explanation of user-level OS access. Avoid a universal “safe plugin” badge.

## Security belongs to the host

Strict manifest v2 declares an execution profile. Orca validates the complete release and derives its minimum class from its contributions. Names, categories and repository labels convey no authority.

| Profile          | Allowed behavior                                                            | User decision                           |
| ---------------- | --------------------------------------------------------------------------- | --------------------------------------- |
| `data`           | Validated translations, grammar/configuration JSON and appearance data      | Install/Enable                          |
| `sandboxed-ui`   | Approved UI, including isolated file parsers and host-owned viewer surfaces | Review execution and opened-file access |
| `instructional`  | Approved launch instructions, recipes and keybindings                       | Review changed instructions             |
| `trusted-worker` | Existing full-trust worker runtime                                          | Explicit full-trust review              |

The last two profiles preserve the existing experimental families. This cohort adds no remote plugin-process runtime.

A data package cannot declare worker entries, viewers, scripts or instructional effects. Unknown fields and inconsistent declarations fail validation. Slow regexes still need bounded, terminable grammar workers: data-only does not mean harmless to performance.

If a language package gains executable features, stage the candidate and require fresh approval. Review names the changed authority and source and binds the exact bytes. Enable is not approval. A stale dialog cannot approve another candidate. Decline retains the verified installed release. A mutable development package follows the same gate; its changed contributions disappear until validated and reviewed.

Installation never executes author build/install scripts, checkout hooks or filters. Exact Git commits retain their repository object format. SHA-1 supports the Git 2.25 baseline; a SHA-256 release requires host support and otherwise explains how to retry after updating Git. This does not add a hard transport-download limit. Updates are explicit. Source ownership changes require review. Bundled activation accepts only exact, app-pinned data snapshots; an official-looking community package cannot inherit that privilege.

### Approval and activation state

```text
Discover → stage exact release → validate manifest + artifacts + compatibility
  invalid                     → reject; retain current release
  valid data                  → publish after explicit Install/Update
  execution or changed trust  → pending review
    decline                   → discard candidate; retain current release
    approve exact candidate   → publish approved generation
  disable/remove/revoke       → retire contributions and document sessions
```

Local development edits pass through the same classifier. Editing a language manifest to `trusted-worker` cannot reuse its data approval. No candidate code runs to determine its own permissions, and no candidate may replace the verified current generation before the required review succeeds. Persist the installed pin and approval separately from enabled and selected preferences.

## Concrete runtime boundaries

**Locales:** English stays in core as recovery text. An exported English kit records per-entry source hashes; changed translations become stale and fall back to English. Validate placeholders and plurals. Security-sensitive copy stays core-reviewed. Show coverage and freshness separately. An opt-in refresh job can propose changes; it cannot stamp translations reviewed or publish them automatically.

**Syntax:** declarative language identifiers, extensions, grammars and literal editor configuration. No JavaScript configuration or language server. Bound grammar work, pin package/model generations and dispose registrations on disable/update. Recovery offers Retry or Plain text while preserving edits, cursor state and Undo.

**File viewers:** Orca selects the file and viewer and owns the tab, controls and recovery UI. The approved parser runs in an isolated worker and returns bounded text, table or canvas data through the public SDK. Arbitrary author DOM is unavailable. No filesystem, network, shell, secrets or write access is exposed to the parser.

The filesystem's execution host authorizes one regular file and issues a revision-bound, read-only document lease. Reads are bounded ranges, checked before and after I/O. No client-local fallback for an SSH/runtime-owned file. Closing, disconnecting, disabling, updating or revoking destroys the old lease. Reconnect requires explicit Reload; it never replays the old session.

For a user-selected file outside a runtime workspace, require an opaque grant minted by that host's selection authority, bound to the canonical file, authenticated client and current owner. A caller-supplied path or `user-file` flag is insufficient. The host-admin selection method, one-use grant, dedicated client and main route now pass real-file/encrypted tests. The ordinary new-tab path field now offers a read-only remote viewer action. It pins the presented owner generation, uses the host selection lane and refuses core editor fallback. Actual paired-runtime, direct and nested Linux SSH journeys prove selected bytes, disconnect retirement and explicit Reload; a registered non-Git runtime folder also opens a selected outside file; unsupported hosts fail closed.

Initial limits: 50 MiB input, 192 KiB decoded ranges, two concurrent reads per viewer, eight live leases, ten seconds to parse and two seconds per render. Expansion and surface budgets apply separately. Resource retirement uses an independent watchdog; sampled memory limits are not hard heap ceilings. File watching is optional and negotiated; phase-o-1 supports truthful `watch: false` with manual Reload. Authority-lifecycle notifications do not imply file watching.

### Restart and remote ownership

Store the qualified viewer key, file location, positive workspace/host owner, read-only intent and small validated view state. Never store file bytes, selection grants, document leases, authentication sockets or connection-generation provenance.

Restoration revalidates the installed approved viewer, recaptures the current owner and reauthorizes current file bytes. An outside-file selection marker records user intent; it is not a grant. A remote selected file remains read-only and cannot fall through to the ordinary core editor, even when a saved core preference matches its extension. A disabled or removed viewer stays unavailable across restart; enable and explicit Reload are separate recovery actions. A disconnected or changed owner never becomes a local file silently.

These rules apply to registered non-Git folder workspaces as well as Git worktrees. Host support is negotiated independently from desktop support. An unavailable host capability yields a connection/support state, rather than recommending an installation that cannot solve the problem.

The actual paired-host/non-Git-folder two-restart journey now passes: current bytes replace the closed workbook, the same read-only tab/viewer restores, disconnect requires explicit Reload, and a disabled viewer stays blocked after a second restart until enabled and reloaded. This development-build result does not establish a prior-app upgrade or production-package parity.

## Included plugins and independent maintenance

Use one repository per independently maintained package, a small official catalog repository and one shared tooling repository. Proposed names:

```text
orca-plugins                 catalog only
orca-plugin-tooling          templates, schemas, validator, English kit
orca-plugin-locale-pt-br     individual locale
orca-plugin-syntax-typst     individual grammar
orca-plugin-viewer-xlsx      individual file format
```

Repository names are conventions. Package IDs are publisher-qualified; community authors use their own namespace and any supported Git provider. No external repositories are created by this design.

Maintainer loop: **init template → author → validate/test → commit prebuilt artifacts → version/tag → export exact commit/hash → catalog PR**. Keep contributor checks read-only and separate from release secrets. Tags are immutable; releases install without building dependencies. Share generated runtime validators with author tooling so the editor schema, CI and installer cannot drift.

For locale upkeep, a core English change produces a new source kit and a diff. Package CI reports missing and stale translations separately. A maintainer reviews changed English, updates the translation and its source receipt, validates, and publishes an independent release. Users can continue on an older partial pack with English fallback. Automation may prepare this diff or a proposed PR; it cannot mark translations reviewed or release them automatically.

Migrate one existing locale and grammar first. App releases bundle pinned snapshots that work offline with optional plugins off. Approved optional releases can override the same official package; disabling them restores the bundled fallback without rewriting the user's pin. Keep English/plain text recovery. The signed prior release now writes Spanish/dark preferences that survive the new production package and another restart, with included-data disable/restore and real Typst highlighting. This qualifies that macOS cohort; moving all languages still requires broader upgrade and packaged-platform gates.

## What future families reuse

| Later family            | Reuse now                                                  | Design before exposing the API                                                                                                     |
| ----------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Task management systems | Identity, exact releases, catalog, review and lifecycle    | Typed task/project operations, provider-neutral ownership, credential custody, explicit read/write scopes and remote routing       |
| Sidebars and panels     | Discovery, approvals, contribution identity and revocation | Host-owned placement/focus, sandbox UI protocol, bounded messages and separately granted workspace data                            |
| Agents                  | Packaging, release provenance and instructional review     | Terminal CLI launch/arguments/prompts, executable ownership and explicit process authority; executable launch is never locale data |

No speculative all-purpose provider abstraction is needed to keep these lanes open. Add a typed contract for each family when its first real integration defines the requirements.

## Build and acceptance order

| Work package                      | Exit criterion                                                                                            |
| --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Profiles, releases and approvals  | Invalid classifications, source changes, stale reviews and unapproved promotions cannot activate          |
| Templates and maintainer workflow | An author outside the core checkout can validate, package and install all three families                  |
| Included data and locales         | Offline startup, translation drift, plurals, disable/restore and saved preferences work                   |
| Syntax lifecycle                  | Normal/read-only/diff files highlight; update, hostile grammar and recovery preserve editing state        |
| Generic viewer contract           | XLSX and STL share the API; wrong-file/owner/revision reads, hostile inputs and disconnects fail safely   |
| Catalog and end-to-end journeys   | Clean-profile discovery, install, selection, update, decline and removal pass visual/keyboard checks      |
| Release qualification             | Real prior-app upgrade, package update/rollback/crash recovery and the declared platform/host matrix pass |

Design settled does not mean release ready. Current source has extensive local/native integration evidence, including managed Linux startup, file-to-catalog acquisition and selected-file restart. A real signed prior-binary upgrade and refreshed production macOS viewer/recovery cohort now pass. That production package also opens real Linux-only formats in a non-Git SSH folder, repairs damaged files and requires explicit Reload after disconnect. Remaining work includes wider upgrade/update/crash cases, Git transport resource qualification, Windows/WSL and additional packaged-platform/host evidence, and final security/repository review. Preserve these gates; do not mark the phase complete from a successful subset.

The [adversarial discovery checkpoint](phase-o-1-adversarial-review.md) records reproduced catalog/profile contradictions, ambiguous official sources and update-source selection fixes, plus rendered marketplace checks. It preserves the open release gates above.

Detailed contracts: [full phase](phase-o-1.md), [directory](phase-o-1-directory.md), [file opening](phase-o-1-file-opening.md), [viewer resources](phase-o-1-viewer-resources.md), [maintainers](phase-o-1-maintainers.md).

## P0 addition · Environment recipes

The 2026-10-13 scope adds first-class recipes for internal development hosts: create, delete, sleep, list, resume/wake and archive. Support both long-lived machines and ephemeral sandboxes, independently of a Git repository or workspace. Extend the existing recipe/SSH ownership code with a source-bound provider contract and a deliberate UI; do not treat provider archive as workspace archive or connection removal as deletion. The [environment recipe contract](environment-recipes.md) defines the draft foundations and remaining application/host qualification. Earlier three-family evidence retains its historical scope and does not prove this addition.

### 2026-10-13 durable environment operations checkpoint

The fourth draft foundation adds a host-owned operation journal and connects it to authorized CLI execution. It records an intent before approval/execution, checks the selected provider revision, serializes pending provider work with the existing cross-process file transaction lock, and persists exact request/outcome digests with the existing restricted durable writer. Reopening the store returns the recorded operation; it never implicitly reruns it. Resource absence in a list page is not deletion. Deleted resources retain confirmed tombstones. Creation parameters and raw CLI diagnostics are not persisted.

Source and recipe changes encounter the existing host/provider journal, preserving unresolved work rather than gaining an empty store. Interrupted intents have no automatic expiry. Unverifiable mutations block later mutations; list refresh may update inventory but cannot settle an unresolved mutation. The upcoming host adapter must verify authoritative operation receipts, implement safe ownership migration, and refuse connection admission from cached rows during uncertain mutations. Journals cap receipts at 4,096, resources at 1,024 and bytes at 8 MiB; capacity failure stops work without silently evicting idempotence receipts.

Current draft stack: [protocol](https://github.com/stablyai/orca/pull/28281), [artifacts](https://github.com/stablyai/orca/pull/28282), [authorized execution](https://github.com/stablyai/orca/pull/28283), [durable operations](https://github.com/stablyai/orca/pull/28290). These are the first four foundation layers, not a completed feature stack. Current macOS qualification: 128 foundation/process tests across nine files, 63 new tests; 39 executor/journal checks also pass through the standard mixed-runtime runner's production Node lane, plus six selection-boundary checks. Targeted types/lint pass. Actual integration uses six local CLI actions, reopened stores and a two-process race. No corporate machine or new provider UI is exercised.

GitHub CI failures in unchanged terminal replay, repository maintenance timing and a PowerShell fixture remain open; terminal replay reproduces locally. No draft is qualified to merge from the focused results alone. The broader plugin branch still needs managed-host migration (14 current Node diagnostics), provider registration, current consent/host routing, durable recovery and first-class catalog/Environments UI with real SSH/platform qualification. Renderer typing and 31 actual grammar checks pass after moving onto the current engine.

Persistent report: `reports/plugin-system/index.html`; short explanation: `reports/plugin-system/phase-o-1.html`. Historical report and 190 original captures are preserved with their original date/build scope. Reports and screenshots stay local rather than entering PR diffs.

### 2026-10-13 managed-host migration and current native qualification

The legacy SSH relay/provider adapters added by the earlier experiment have been retired alongside main's transport migration. Desktop viewers use the selected environment's paired server; the server derives catalog ownership and opens only its own local filesystem. An unserved `ssh:` or nested `runtime:` target fails without reading this machine. Git-backed admission also confirms current worktree registration with the existing strict, unshared Git listing and the runtime's project/WSL options; degraded saved rows cannot grant bytes. Folder workspaces require no Git. Named outside-file grants remain socket-bound and one-use. Current caller policy allows standard paired host administration and denies mobile access to file selection.

The production desktop build and full Node/web/CLI checks now pass. The managed-viewer regression passes 106 tests/ten files, including 20 focused authority cases using separate client/host profiles, actual sockets and real Git repositories. A fresh production native catalog journey passes with no debug store hook and hidden windows. A source-built Linux arm64 SSH server also passes the native remote-only XLSX/STL journey: malformed-file repair, guest retirement on disconnect, explicit Reload after reconnect and a remote folder without Git. That SSH run uses E2E renderer/preload; the production catalog has separate proof. Production renderer/preload have been restored and the production catalog rerun passes.

Ten fresh captures are persistent under `reports/plugin-system/evidence/managed-rebase-20261013/`; the source/build/identity receipt is `migration-evidence.json`. The main HTML report displays these before historical captures. All 190 historical images remain unchanged in their recovered report. New screenshot output defaults to `reports/plugin-system/evidence/`, with a caller-selected evidence directory for distinct cohorts.

The original full objective remains open: P0 environment-provider registration, source/host consent adapter, authoritative operation recovery and safe source migration, first-class catalog/Environments management UI, full draft stack and remaining lifecycle/platform/transport gates. Current SSH document proof does not qualify provider create/delete/sleep/archive UI. Existing CI terminal replay, repository maintenance, PowerShell and daemon binding failures remain open; the changed recipe suites have local Node-lane evidence. No PR is merged or marked ready.

### 2026-10-13 provider registration and account context checkpoint

Environment providers now have strict v2 manifest contributions, a first-class catalog filter and command review through existing consent. The native production journey installs a pinned Git release, reviews all six literal commands, keeps title/warning/actions visible while scrolling and verifies that install/approval executes no provider code. Current screenshots and receipts live in `reports/plugin-system/`; older captures retain their earlier build scope.

An account-switch CLI fixture demonstrated that matching resource IDs and revisions do not identify the backend account. Opt-in protocol 2 and durable journals now bind an explicit provider context. [The context contract](environment-recipe-context.md) explains the provider's obligation to select/verify the namespace before mutation. [Draft layer 5](https://github.com/stablyai/orca/pull/28305) extends the four foundations without exposing new RPC methods.

The working-branch host adapter uses real installed-plugin discovery, current source/content/release consent, immutable recipe admissions and host-selected control context. It passes actual local subprocess checks for all six actions and withdrawal. Shared recipe loading and content lifecycle logic are reused; refresh, reconciliation, removal and shutdown revoke held provider authority before async work settles.

Still required: first-class Environments management and explicit account configuration, negotiated paired-host lifecycle methods, ordinary SSH connection handoff, authoritative interrupted-operation recovery/source migration, the rest of the full draft stack and platform/release gates. The host adapter is not yet bound to desktop IPC or managed-host RPC. One earlier combined dev-tree fixture run was conservatively interrupted; installed-plugin tests qualify the immutable installation path, and dev-watcher interruption remains an explicit qualification lead.

### 2026-10-13 desktop lifecycle management checkpoint

Trusted desktop IPC now connects the provider host adapter to SSH host management. The UI sets up an explicit account, reads retained inventory, runs list/create/sleep/resume/archive/delete through literal reviewed commands and uses source-bound confirmations. Creation fields, destructive Cancel focus, duplicate-submit protection and owner-bound stop/reload behavior have direct evidence. Two native production-build journeys pass against the owned local CLI fixture, with 12 new lifecycle captures; the persistent overview now contains 31 actual captures and retains all 190 historical captures separately.

Current selected regression: 96 tests/14 files, with full Node/web/CLI typing, a production desktop build and all seven quality scans/624 changed JS/TS files passing. These checks do not qualify a live corporate provider or SSH handoff. Complete connection ownership/retirement, account/source migration, disabled-provider history, portable author adapters, remote lifecycle RPC, authoritative recovery and the rest of the draft stack/platform gates before declaring the phase complete.

### Scoped SSH handoff · 2026-10-13

The desktop provider flow now reviews a fresh, source/account/resource-bound SSH endpoint, saves a main-owned target and calls ordinary SSH connection management. A revocable lease covers admission, reuse, handshake and live transport. Selected sleep/archive/delete operations retire both SSH contact and managed tunnels while retaining machine/workspace history and target generation; creating an unrelated sandbox keeps the devbox connected. Endpoint changes fail closed pending explicit migration. Window ownership, expiry and in-progress save withdrawal fence review tickets.

Current native production proof reaches an owned Linux SSH server, a folder without Git and real terminal input. Sleep/wake changes the owned CLI fixture’s inventory, retires contact and explicitly reconnects; physical machine power and corporate fleet integration are outside that proof. The current selection passes 102 tests/19 files, full typing, desktop build and seven quality scans/652 changed files. The expanded hidden SSH/folder journey passes in 16.0s with no debug store hook. Six foundations are now drafts; [layer 6](https://github.com/stablyai/orca/pull/28339) qualifies contained file reads separately on its exact isolated tree (24 tests/three files and Node typing).

Keep the full objective open until negotiated paired-control-host lifecycle APIs, authoritative recovery, safe ownership migration, disabled-provider history, portable adapters, competing-client/platform/restart qualification and the remaining application PRs are complete. This checkpoint does not waive original catalog/viewer release gates.

### Authoritative receipts and visible history · 2026-10-13

The working branch now supports opt-in, source-reviewed operation inspection for context-aware providers. Host-built queries bind the original request digest, account, action, resource and revision. A terminal provider receipt settles the reservation while preserving the original interrupted observation; historical outcome is separate from current inventory. Missing/pending/error receipts keep the fence. No mutation is replayed, no caller receipt is accepted and old creation parameters are not persisted or resent.

Native production proof shows an applied create with a lost response, owner-bound Stop, an unresolved row, a pinned receipt review and confirmed current machine plus retained history. A rendered check removed the stale error after confirmation. All five mutations have real subprocess recovery checks. Current selection: 149 tests/21 files, full types, desktop build, seven quality scans/667 changed files and three native journeys/25.1s pass. The refreshed actual Linux SSH/folder/terminal journey passes separately/17.2s after waiting for its observed PTY binding; pre-bind input loss remains a qualification lead rather than being hidden.

[Draft 7](https://github.com/stablyai/orca/pull/28345) isolates the contract and review data, with 54 tests/four files and exact-tree Node typing. The report now embeds 40 actual captures and preserves the historical 190-capture artifact. Further crash/client/platform coverage, paired control-host execution, migration, disabled history, portable adapters, application-stack publication and original release gates remain open.

### 2026-10-13 explicit source/account migration

Provider configuration now has a two-step review: execute only the approved List command against the proposed account, then confirm the actual inventory before selecting a new durable journal generation. Previous journals remain readable and unchanged. Same-account source updates carry unresolved operations with their original provenance; switching accounts refuses unresolved machine changes. Missing selected generation files fail closed rather than making an empty inventory. Main-private, single-use review tickets expire after five minutes and belong to the requesting window; reload, crash, stale history or withdrawn source approval prevents selection.

Saved SSH source ownership can be rebound only through the host-owned previous-binding history and a fresh connection review for the same provider/account/machine and unchanged endpoint. This preserves target identity, credentials and generation. It does not silently retarget a saved connection or copy another account's ownership. Selection retires provider contact while preserving machine and workspace records.

Adversarial review found that the marketplace offered provider update approval without the full command review the backend required; the backend correctly refused it. Source previews now include contained, validated recipe commands tied to the reviewed content hash. The update dialog shows program, literal arguments, timeout and optional receipt lookup, with a fixed header/footer and scrolling content. Missing command previews block approval. Provider-only updates also require the exact command-review digest, checked against a fresh source preview. Other instructional or mixed updates retain the existing full-review refusal. This extends the existing command review rather than creating a second permission scheme.

Current application selection passes 191 tests/28 files, full typing and seven changed-code quality scans/681 files. [Draft layer 8](https://github.com/stablyai/orca/pull/28355) isolates durable receipt/generation storage and passes 26 tests/four files plus Node typing on its exact tree. Native migration proof is recorded separately once the production journey passes. Paired control-host lifecycle routing, disabled-provider history, portable repository adapters, competing-client/platform/release checks and full application-stack publication remain required.

Latest native migration checkpoint: the production source-update, fresh inventory review, read-only history, 1000×720 dialog and restart journey passes in 10.8s. The current selected regression is 205 tests/30 files, full typing and seven quality scans/683 files. Nine foundation drafts are published, including [receipt execution #28361](https://github.com/stablyai/orca/pull/28361), independently checked with 27 tests/four files and exact-tree Node typing. Persistent HTML now embeds 46 actual captures; the recovered 190-capture original is unchanged. Full application-stack publication and the previously listed remote/platform/release gates remain open.

### Application foundations and retirement preflight checkpoint, 2026-10-13

Drafts 10–13 now isolate strict profiles/releases (#28364), checkout-free Git materialization (#28366), exact installation/publication (#28379) and source-bound host registration/SSH ownership (#28383). Their exact trees pass 138/8, 39/4, 89/7 and 107/16 tests/files respectively, plus Node typing. Two focused compatibility cases pass on real Linux Git 2.25.1 and 2.30.0; other binary cases were unselected, and CI adds the pinned 2.29 boundary.

Adversarial integration review corrected migration ordering: stale history, withdrawn window authority and a superseded account selection are checked before retiring contact. Migration preflight keeps live SSH leases current; actual selection starts fencing and retirement before publication. Direct regressions cover both the callback and the live lease.

The current full application passes 211 selected tests/31 files, full typing, seven quality scans/684 files and a fresh production main/preload/renderer build. Three current native journeys pass in 28.9s: lifecycle management, source migration/history/narrow review/restart and interrupted creation recovery. Public application IPC/UI, ecosystem stack publication and the remaining documented integration/release gates stay open. Reports remain copied outside the worktree under Documents/Orca Reports/Plugin System/2026-10-13.

### Current application and authoring checkpoint — 2026-10-13

Eighteen open draft layers now include runtime document authority, trusted-window/main-frame desktop management, editor lifetimes, the first-class catalog/provider UI and independent author contracts/templates. The original phase scope and release gates remain in effect. Exact isolated trees pass 69/6, 175/19, 106/16 and 105/14 tests/files for layers 14–17; these overlapping selections are not added together. Both renderer layers typecheck and build. The isolated catalog tree passes catalog installation, included-pack recovery/override and independent folder viewer lifetime/restart journeys. Its separately rebuilt production bundle passes four native provider journeys in 34.7 seconds, with no debug store and every app window hidden.

The author package passes 19 tests, including installed-tarball initialization/release for three templates. Current runtime validators, four schemas and the English locale kit pass snapshot verification. The SDK builds with pinned TypeScript 5.9.3 and the workspace compiler. Clean-checkout testing caught missing generated template artifacts and stale validators; both are corrected. Translation source hashes remain unchanged unless reviewed; the example revision updates only after checking its translated source hash.

The current source regression passes 355 tests/45 files, full typing and changed-code quality. The persistent report contains 54 actual captures and all draft links; the recovered 190-capture original remains byte-identical. Reports are copied to Documents/Orca Reports/Plugin System/2026-10-13 outside the worktree. No draft is merged or declared ready. Remaining stack work includes shared file authorization cleanup, maintained file-format packages, public directory and CI. Endpoint migration, disabled-provider history, portable provider adapters, negotiated control-host lifecycle, unaffected-refresh lease preservation and remaining crash/client/platform/transfer/original release gates remain open.

### Full current implementation stack — 2026-10-13

The existing implementation is split into 23 open draft PRs. New layers 19–23 separately cover shared selected-file authorization, maintained XLSX/STL and data packages, the public directory, generic-settings authority protection, and CI/packaging qualification. The public directory includes Environment providers with a clear host/account review boundary. Actual page-to-app installation matches the displayed commit/hash and opens a real workbook; the site is not deployed.

The final exact draft passes 422 tests/42 files with one Windows-only case unselected on macOS, Node/web/CLI types, four workflow parses, and fresh e2e/production builds. Four native adversarial journeys pass: inert review, syntax recovery with edits/healthy neighbor preserved, installed parser memory/loop/flood/API retirement, and readonly intent through restart. Nine directory browser cases pass. Four separately rebuilt production provider journeys pass in 34.7 seconds with no debug store and no visible windows. Current source typing and seven changed-code scans/689 files pass. The primary mixed index remains unchanged. CI configuration does not imply executed Linux/Windows qualification; no draft is merged or declared ready. Endpoint/history/adapter/control-host/refresh work and the remaining original release gates remain open. Persistent reports now embed 65 actual captures and all 23 draft links; the original 190-capture report remains byte-identical.

### Inactive-provider history implemented — 2026-10-13

[Draft 24](https://github.com/stablyai/orca/pull/28443) adds host-owned, read-only saved provider inventory/history independently of currently approved recipes. Bounded context enumeration rejects forged filenames, foreign ownership, corrupt files and dangling links. Explicit reads use the existing selected journal and retained previous account/source generations, rechecking selection after reading. The projection carries no approval token or executable recipe. Trusted app-window/main-frame IPC protects optional desktop methods; no remote opcode or local fallback is introduced.

The SSH Hosts surface remains available with a provider or the whole plugin system off. Saved rows expose inventory, operation history and generation/resource pagination without connection, lifecycle or receipt controls. Re-enabling unchanged reviewed code restores normal management; removal explains that host-owned history remains. The exact draft passes 34 tests/six files, Node/web typing and a production build. A production native journey passes in 16.6 seconds over three launches with a long-lived machine and temporary sandbox. The actual CLI PID log retains only the original explicit inventory/create invocations through disable, system-off, removal, reads and restores. No debug store or visible window. Current types and seven quality scans/696 files pass. Reports now embed 71 captures and all 24 draft links, with their stated owned-fixture/macOS scope. Endpoint migration, adapters/control-host execution, unrelated-refresh preservation and remaining original release gates stay open.

### 13 October 2026 — unchanged provider connections survive plugin refresh

[Draft 25](https://github.com/stablyai/orca/pull/28444) scopes environment authority retirement to the affected provider. Unchanged owner/source/commands retain their existing admission and SSH lease only after fresh content and artifact verification. No-op refresh, paused reconciliation and unrelated installation/removal preserve it. Missing, changed, disabled, killed, corrupt or removed owners are revoked; a slow neighbor cannot postpone a known failure. Generation checks discard late admission failures and prevent withdrawn authority from being restored. The temporary global content-readiness flag no longer retires held provider SSH authority; live approval, selected account/resource binding and discovered source identity still gate it. Re-enable replaces a revoked combined lease; the old lease stays revoked. Other plugin content retains the existing readiness gate.

The exact isolated seven-file draft passes 73 tests/nine files, Node typing and a fresh production main/preload/renderer build. Seven changed-code scans/696 files pass. The production saved-history regression passes in 18.8s over three app launches, with no debug store and every window hidden. It checks disable/system-off/re-enable/removal/restart with a devbox and temporary sandbox. Connection lifetime checks hold actual SSH authorization signals over an installed-plugin/local-CLI fixture; they do not claim a live corporate SSH session, physical power transition or Windows/WSL qualification. Persistent reports contain 73 actual captures and all 25 draft links; the 190-capture original remains byte-identical. No merge or deployment.

The full phase remains open: explicit endpoint migration, portable provider adapters, negotiated control-host lifecycle, hard Git transfer bounds and the original update/rollback/crash/client/platform/packaged/remote-watch release gates.

### 13 October 2026 — explicit saved SSH endpoint updates

[Draft 26](https://github.com/stablyai/orca/pull/28450) isolates the stable target identity and ownership/storage fence. [Draft 27](https://github.com/stablyai/orca/pull/28477) extends fresh-inventory, window-owned connection review with old/new details and an explicit approval flag. Older renderers cannot silently accept updates they cannot display. The ticket privately pins the original target and credentials; ownership is checked before retiring its exact contact, then authority and the pinned registration are checked again before publication. Cancel, expiry, source/account/resource withdrawal, competing credentials/registrations, foreign ownership, failed retirement and pending managed-server provisioning fail closed. The target ID, workspace records, credentials and server fence are retained; an endpoint change advances registration generation and clears previous endpoint runtime/server decisions.

The security dialog keeps its title/warning/actions fixed, scrolls a labeled details region and focuses Cancel for updates. Declined, abandoned, consuming and late reviews can be withdrawn without filling the bounded 32-ticket pool. Successful host saving remains explicit if reconnecting fails; the existing error formatter removes internal IPC prefixes. Forty-six previously missing English keys are added from their actual source defaults. Current translation-kit output is checked; the example revision changes only after confirming its translated source hash is unchanged. Provider SSH tests are assigned to the CI lane that builds their source server template, including the conservative general-lane fallback.

Exact source: 155 regression checks/13 files, with 28 affected UI/error checks/three files requalified after final copy/error polish. These selections overlap. Node/web types, fresh production builds, 19 author package/tarball/template checks, localization extraction, runtime/schema/English-kit snapshots and seven changed-code scans/702 files pass. Existing extraction report-only findings remain reported. The final production endpoint journey passes in 25.9s (26.3s suite) over two launches. It proves actual SSH attempts to an owned rejecting TCP endpoint, Cancel preservation, explicit same-ID/new-generation update, exactly five explicit CLI invocations and restart without another provider call. No debug store; every window hidden. An earlier separately rebuilt endpoint plus saved-history regression passes together in 42.0s.

This qualifies macOS desktop review/registration/error/restart over owned Git/CLI/TCP fixtures. It does not qualify a moved active Linux SSH transport, corporate fleet or machine power. Docker’s desktop-linux API was unresponsive; only the verified owned read-only Docker CLI was terminated, not Docker or its containers. Active remote endpoint migration stays open alongside portable provider adapters, negotiated paired-control-host lifecycle, hard Git transfer bounds and original update/rollback/crash/client/platform/packaged/remote-watch gates. The report embeds 78 actual captures and all 27 draft links; the recovered 190-capture report stays byte-identical. No merge or deployment.

### Repository-shipped provider adapters · 2026-10-13

The P0 company-provider author contract now supports a prebuilt single ESM adapter through Orca’s pinned Node runtime, alongside literal installed company CLIs. [The portable adapter contract](environment-portable-adapters.md) defines current-source artifact capture, protocol-2 account binding, full-account approval, cancellation, runtime-preparation refusal and offline authoring. This reduces company integration setup while preserving independent source, SSH destination and changed-endpoint review. Paired control-host lifecycle, active remote endpoint migration and remaining original release gates stay open.
