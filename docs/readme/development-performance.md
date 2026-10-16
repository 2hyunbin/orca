# Faster local development

Use `pnpm dev` while editing the desktop app: the renderer updates through Vite, and
the main process builds without minification. Use `pnpm dev --watch` when editing
main-process or preload code so Electron restarts after those changes. Keep the dev
process running to reuse its in-memory transforms.

For machines running many agents, prefix an existing script with `pnpm lean`:

```sh
pnpm lean dev --watch
pnpm lean test src/main/some-feature.test.ts
pnpm lean tc
pnpm lean build:electron-vite
```

These commands work in macOS, Linux and Windows shells. Lean mode gives each
invocation two native build threads, two Vitest workers, and one typecheck project
at a time. It runs the same checks and produces the same production bundles. Each
invocation has its own budget; ten simultaneous invocations can still use twenty
native threads. Programs started by the command inherit these environment limits.

Choose the smallest command that checks your change:

| Task                                        | Command                               |
| ------------------------------------------- | ------------------------------------- |
| Desktop UI or main-process development      | `pnpm lean dev --watch`               |
| Browser client development                  | `pnpm lean dev:web`                   |
| Renderer-only edits after a desktop build   | `pnpm lean dev --rendererOnly`        |
| One unit test file                          | `pnpm lean test path/to/file.test.ts` |
| Main-process typecheck                      | `pnpm lean tc:node`                   |
| Renderer typecheck                          | `pnpm lean tc:web`                    |
| CLI typecheck                               | `pnpm lean tc:cli`                    |
| JavaScript desktop bundle and output checks | `pnpm lean build:electron-vite`       |

`--rendererOnly` uses the existing main/preload output: run a normal dev build
first, and restart without this flag after changing either of those targets.
`build:electron-vite` does not replace the typechecks, native builds, CLI, web and
mobile-web outputs that a complete `pnpm build` performs.

## Adjusting the budget

Explicit environment values override lean defaults. Set them using your shell or
agent environment configuration:

| Setting                  | Effect                                                             |
| ------------------------ | ------------------------------------------------------------------ |
| `ORCA_BUILD_THREADS`     | Lean native thread default; native and Bun typecheck thread budget |
| `ORCA_BUILD_CONCURRENCY` | Maximum simultaneous projects in the full typecheck                |
| `ORCA_TEST_MAX_WORKERS`  | Root Vitest worker limit                                           |
| `RAYON_NUM_THREADS`      | Explicit Rust build thread limit                                   |
| `GOMAXPROCS`             | Explicit Go compiler runtime limit                                 |
| `NODE_OPTIONS`           | Node settings, including an explicit `--max-old-space-size=2048`   |

For one command, `pnpm tc --concurrency=1` and `pnpm test <file> --maxWorkers=1`
override the configured concurrency. A Node heap limit does not cap native Rust
or Go allocations or total process memory; lowering it too far can fail builds.

If development startup unexpectedly builds the browser pairing client, set
`ORCA_SKIP_DEV_WEB_PREPARE=1` when browser pairing is unnecessary. An existing web
bundle can otherwise be rebuilt when renderer sources change. Refresh it with
`pnpm build:web` before testing browser pairing.

Vite dependency caches live in `.cache/vite/renderer` and `.cache/vite/web` inside
each worktree. Shared `node_modules` installs therefore keep independent caches
for each worktree and target. These caches are ignored by Git and excluded from
packaging. Keep worktrees separate when building concurrently; one worktree's
`out/` directory is still shared by its build commands.
