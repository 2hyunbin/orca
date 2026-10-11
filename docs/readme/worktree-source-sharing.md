# Experimental sharing of tracked worktree source (P3)

Orca already shares configured extra paths, included files, Electron distributions, and development
bundles. Git also shares its compressed object database between worktrees. The remaining gap is
the checked-out tracked files: ordinary worktree creation writes another copy of their file data.

P3 adds an opt-in APFS path to Orca's existing locked checkout preparation. Enable it in the process
running Orca, for example during development:

```sh
ORCA_EXPERIMENTAL_SOURCE_SHARING=1 pnpm dev
```

Omit the variable to retain ordinary checkout. This is a storage experiment, not a speed feature.
It currently covers prepared checkouts on local macOS/APFS. Creation that bypasses preparation,
including preparation misses, keeps the existing Git checkout. Existing worktrees are not changed.
Folder workspaces have no tracked Git checkout to share.

## How it works

The first preparation exports committed tracked files into a read-only source seed under
`<git-common-dir>/orca-cache/tracked-source-v1/seed`. It reads the new worktree's index, so dirty
source files, ignored files, and local secrets are excluded. The seed contains no Git index or
worktree registration.

Later preparations at the same commit clone the seed through Orca's existing APFS primitive.
Each checkout has separate files and its own Git index. Editing one checkout allocates private
blocks and leaves the seed and other checkouts alone. Mutable source never uses hardlinks.

The new index is built through Git, refreshed against the cloned files, and then passed through the
existing hard reset and finalization. Post-checkout hooks still run at finalization. Git's normal
file-change detection remains enabled; the seed's index is never copied into another checkout.

Seed identity includes the exact commit, tracked paths and modes, Git version, effective checkout
configuration, and effective attributes for every tracked path. Attribute reads include external
attribute files. Branch and push bookkeeping are excluded because finalizing a worktree changes
them without changing checkout bytes. Configuration and attributes are checked again before
publication. A new identity replaces the previous seed; the cache retains at most one complete
seed and one temporary build. Interrupted temporary builds are removed on the next cache use.

A host-local transaction lock protects both replacement and copying. It acts as a lease: another
process cannot evict a seed while it is being cloned. Contention takes ordinary checkout rather than
waiting. Copy processes have deadlines and receive cancellation; cancellation or changed worktree
lock ownership aborts creation. Other sharing failures fall back to the existing hard reset.
Incomplete copies and malformed or damaged seeds are discarded.

## Scope and fallbacks

Content filters, sparse checkout, submodules, prepopulated preparation directories, incompatible
filesystems, and different volumes use ordinary checkout. Windows, Linux, and WSL retain their
current behavior. No remote protocol changes are introduced, and no filesystem operation is
performed on a client for an SSH repository. Remote hosts continue their existing checkout path
unless their own macOS backend enables the experiment and supports this preparation path.

Relative symlinks, executable bits, and Git text/line-ending attributes are covered by tests.
The Git commands used here predate Git 2.25; the source-export contract is included in the existing
real-binary compatibility matrix. See Git's documentation for
[`checkout-index --prefix`](https://git-scm.com/docs/git-checkout-index/2.0.5) and
[`check-attr --cached`](https://git-scm.com/docs/git-check-attr/2.0.5).

## Storage and time measurements

Two full-tree runs used commit `d2ba67d1090a0e7707532ebbf4a12e935dbe0185`, macOS/APFS, Git 2.55.0,
and the implementation based on `5e9fb931a106`. Each tree contained 35,620 files. Times include
registration, materialization, and the first clean status check.

| Method                             | Run 1   | Run 2   | Private file data per checkout |
| ---------------------------------- | ------- | ------- | ------------------------------ |
| Ordinary checkout                  | 21.67 s | 26.61 s | 357.22 MiB                     |
| Shared checkout, creating the seed | 42.83 s | 35.31 s | 4 KiB                          |
| Shared checkout, reusing the seed  | 26.45 s | 11.96 s | 4 KiB                          |

The 4 KiB includes the independent `.git` pointer. Shared data still occupies one source copy;
these measurements exclude filesystem metadata overhead. At 100 same-commit worktrees the file
data saving is approximately 34.5 GiB after allowing for one seed. Different commits and subsequent
edits consume additional blocks. Deleting or replacing the seed leaves existing clones intact.

Timing varied substantially with machine activity. Method order was ordinary, cold seed, then warm
seed in each run, so cache warmth can also affect the comparison. These samples demonstrate sharing
and write isolation; they do not establish a creation-speed improvement. An earlier, smaller
prototype measured ordinary checkout at 3.60–4.13 seconds and source cloning at 9.87–13.45 seconds.
That prototype reused nearby commits; the implementation deliberately restricts reuse to the exact
commit and checkout settings to avoid inheriting incorrect transformed files.

Keep this off by default while testing representative repositories. Broader rollout needs more
timing samples and tests of additional Git checkout settings. Linux reflinks and remote-host
implementations can extend the same preparation boundary after host-specific validation.

## Reproduction

```sh
ORCA_BACKGROUND_LAUNCH=1 pnpm test src/main/git/worktree-source-cache.test.ts src/main/git/worktree-source-cache-real-apfs.test.ts
ORCA_BACKGROUND_LAUNCH=1 pnpm exec tsx tests/tools/benchmarks/worktree-tracked-source-benchmark.ts d2ba67d1090a0e7707532ebbf4a12e935dbe0185 2
```

The benchmark creates disposable repositories on the same volume, references existing Git objects,
verifies clean checkouts and independent writes, audits APFS private file allocation, and removes
all scratch repositories in `finally`. It does not register anything in the user's repository.
No Electron app or rendered UI is needed. Raw results and implementation hashes are in
`tests/tools/benchmarks/worktree-storage-evidence/tracked-source-production-benchmark.json`.

P2 is separate: sharing historical release source for cross-version tests. Its local prototype is
not part of this change.
