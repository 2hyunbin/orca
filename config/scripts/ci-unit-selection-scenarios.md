# Audit unit selection

The selector remains conservative: unknown/global inputs run the full suite. Before narrowing it,
compare representative source-only changes with complete full-run artifacts.

1. Download every `unit-shard-node-*-attempt-N` artifact from one PR run attempt into a directory
   outside the checkout. Keep each shard's `unit-selection.json` beside its `unit-timings.json`.
2. Check out the artifacts' `sourceSha` (the tested merge commit), install its dependencies, and
   keep the checkout clean. Remove ignored source artifacts such as stale `src/**/*.js` files;
   the audit rejects inputs absent from Git. Use a revision containing this audit command.
3. Save scenarios outside the checkout, using repository-relative paths with `/` separators:

   ```json
   {
     "terminal link": ["src/shared/terminal-file-url-target.ts"],
     "abort handling": ["src/shared/abort-aware-delay.ts"],
     "global fallback": ["pnpm-lock.yaml"]
   }
   ```

4. From the repository root, run:

   ```sh
   node config/scripts/ci-unit-selection-scenarios.mjs /path/to/artifacts /path/to/scenarios.json
   ```

Read `selection-scenarios.json` in the artifact directory. It lists selected files, fallback reasons,
failures outside each selection, and potentially omitted worker time for each runtime/reference.
Missing shards, selected runs, source mismatches, and different test inventories are rejected.

Replay checks recorded failures; it does **not** simulate edits or prove that selection catches
future regressions. Worker time overlaps and is **not** elapsed CI time. Keep full ready-for-review
checks, compare real source-only PRs in shadow mode, and measure queue/setup/runner time before
enabling a draft pilot. This command changes no CI scheduling or selection policy.
