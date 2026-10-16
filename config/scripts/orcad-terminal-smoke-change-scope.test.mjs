import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runProcessSync } from '@orca/process-host'
import { beforeAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  classifyOrcadTerminalSmokeChanges,
  collectOrcadTerminalSmokeInputs
} from './orcad-terminal-smoke-change-scope.mjs'
import { ORCAD_CHILD_ENTRY_POINTS } from './orcad-entry-build.mjs'

const registrationRoot = 'src/main/runtime/orca-runtime.test.ts'
const registrationFragment =
  'src/main/runtime/orca-runtime-tests/repository-project-operations.spec.ts'
const registrationEvidence = {
  modifiedFiles: [registrationFragment],
  rawDiff: `:100644 100644 ${'1'.repeat(40)} ${'2'.repeat(40)} M\0${registrationFragment}\0`
}
const historicalDiff = JSON.parse(
  readFileSync(
    new URL('./node-server-runtime-registration.test-fixture.json', import.meta.url),
    'utf8'
  )
)

it.each([false, true])(
  'checks smoke and unit registration graphs separately: consumed=%s',
  async (consumed) => {
    const result = await classifyOrcadTerminalSmokeChanges(
      [registrationFragment],
      async () => new Set(['src/cli/index.ts', ...(consumed ? [registrationFragment] : [])]),
      {
        ...registrationEvidence,
        collectRegistrationInputs: async ({ entryPoints }) => {
          expect(entryPoints).toEqual([registrationRoot])
          return new Set([registrationRoot, registrationFragment])
        }
      }
    )
    expect(result.shouldRun).toBe(consumed)
    expect(result.graphResolved).toBe(true)
  }
)

it('retains smoke when the unit registration graph fails', async () => {
  const result = await classifyOrcadTerminalSmokeChanges(
    [registrationFragment],
    async () => new Set(['src/cli/index.ts']),
    {
      ...registrationEvidence,
      collectRegistrationInputs: async () => {
        throw new Error('registration unavailable')
      }
    }
  )
  expect(result.shouldRun).toBe(true)
  expect(result.graphUnavailable).toBe(true)
})

it.each([
  '.github/workflows/pr.yml',
  'config/scripts/orcad-terminal-smoke-change-scope.mjs',
  'config/scripts/orcad-terminal-smoke-change-scope.test.mjs',
  'config/scripts/node-server-change-scope.mjs'
])('retains policy qualification alongside a registered fragment: %s', async (file) => {
  const files = [registrationFragment, file]
  const result = await classifyOrcadTerminalSmokeChanges(
    files,
    async () => {
      throw new Error('policy changes must force qualification before graph analysis')
    },
    {
      modifiedFiles: files,
      rawDiff: files
        .map((path) => `:100644 100644 ${'1'.repeat(40)} ${'2'.repeat(40)} M\0${path}\0`)
        .join('')
    }
  )
  expect(result.shouldRun).toBe(true)
  expect(result.graphUnavailable).toBeUndefined()
})

it.each([
  'package.json',
  'pnpm-lock.yaml',
  'tsconfig.json',
  'config/tsconfig.cli.json',
  'config/patches/node-pty@1.1.0.patch',
  'native/windows-registry/src/addon.cc',
  'config/scripts/node-pty-job-ownership.cjs',
  '.github/actions/install-node-dependencies/action.yml',
  '.github/workflows/pr.yml',
  'src/cli/deleted-command.ts',
  'src/shared/deleted-contract.ts',
  'src/main/persistence/profile-state/new-worker.ts',
  'resources/licenses/ripgrep/COPYING',
  'config/scripts/runtime-serve-terminal-smoke.test.mjs',
  'config/scripts/orcad-terminal-smoke-change-scope.test.mjs'
])('retains the smoke for build and dynamically opened input changes: %s', async (file) => {
  expect((await classifyOrcadTerminalSmokeChanges([file], async () => new Set())).shouldRun).toBe(
    true
  )
})

it('retains smoke when changed-file evidence or dependency analysis is unavailable', async () => {
  expect((await classifyOrcadTerminalSmokeChanges([])).shouldRun).toBe(true)
  const result = await classifyOrcadTerminalSmokeChanges(['src/main/deleted.ts'], async () => {
    throw new Error('Could not resolve deleted dependency')
  })
  expect(result.shouldRun).toBe(true)
  expect(result.reason).toContain('Dependency graph unavailable')
})

describe('the actual terminal smoke dependency graph', () => {
  let inputs
  beforeAll(async () => {
    inputs = await collectOrcadTerminalSmokeInputs()
  }, 60_000)

  it.each([
    ...Object.values(ORCAD_CHILD_ENTRY_POINTS),
    'src/main/runtime/orca-runtime.ts',
    'src/main/windows/windows-process-table.ts',
    'src/main/worker-thread-entry-path.ts',
    'src/cli/index.ts',
    'config/scripts/runtime-serve-terminal-smoke.mjs',
    'config/scripts/build-orcad-node.mjs',
    'config/scripts/build-orcad.mjs',
    'config/scripts/profile-state-worker-smoke.mjs',
    'config/scripts/install-dev-cli.mjs',
    'config/scripts/verify-cli-bin.mjs',
    'config/scripts/node-server-change-scope.mjs'
  ])('retains the runtime, CLI, build or smoke dependency: %s', async (file) => {
    expect(inputs.has(file)).toBe(true)
    expect((await classifyOrcadTerminalSmokeChanges([file], async () => inputs)).shouldRun).toBe(
      true
    )
  })

  it.each([
    'src/renderer/src/components/Example.tsx',
    'src/main/menu/register-app-menu.ts',
    'config/scripts/ci-shard-timings.json',
    '.github/workflows/e2e.yml',
    'docs/reference/ci-runner-efficiency.md'
  ])('skips unrelated inputs: %s', async (file) => {
    expect((await classifyOrcadTerminalSmokeChanges([file], async () => inputs)).shouldRun).toBe(
      false
    )
  })

  it('retains a removed source path when a file is renamed outside the CLI tree', async () => {
    expect(
      (
        await classifyOrcadTerminalSmokeChanges(
          ['src/cli/deleted-command.ts', 'docs/moved-command.ts'],
          async () => inputs
        )
      ).shouldRun
    ).toBe(true)
  })
})

it('classifies a real historical diff through the current smoke CLI and graphs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'orcad-smoke-scope-'))
  try {
    const changes = join(directory, 'changes')
    const modified = join(directory, 'modified')
    const diff = join(directory, 'diff')
    writeFileSync(changes, `${historicalDiff.changedFiles.join('\0')}\0`)
    writeFileSync(modified, `${historicalDiff.changedFiles.join('\0')}\0`)
    writeFileSync(diff, historicalDiff.rawDiff)
    const invoke = (args) =>
      runProcessSync({
        program: process.execPath,
        args: [
          fileURLToPath(new URL('./orcad-terminal-smoke-change-scope.mjs', import.meta.url)),
          changes,
          ...args
        ],
        env: { ...process.env, GITHUB_OUTPUT: join(directory, 'step-output') },
        timeoutMs: 60_000
      })
    const complete = invoke(['--modified-paths', modified, '--diff-paths', diff])
    expect(complete.code).toBe(0)
    expect(complete.stdout).toBe('false\n')
    const incomplete = invoke(['--modified-paths', modified])
    expect(incomplete.code).toBe(0)
    expect(incomplete.stdout).toBe('true\n')
    expect(
      invoke(['--modified-paths', modified, '--diff-paths', join(directory, 'missing')]).code
    ).not.toBe(0)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 60_000)

it('only skips the unchanged smoke after a successful diff and dependency analysis', () => {
  const workflow = parse(
    readFileSync(new URL('../../.github/workflows/pr.yml', import.meta.url), 'utf8')
  )
  const step = workflow.jobs.preflight.steps.find(
    (candidate) => candidate.name === 'Boot orcad and round-trip a terminal'
  )
  expect(step.env).toEqual({
    BASE_SHA: '${{ github.event.pull_request.base.sha }}',
    ORCA_BACKGROUND_LAUNCH: '1'
  })
  // See the localization gate: HEAD^1 removes the merge-base computation, so a shallow checkout
  // is enough and the payload head SHA is unused.
  expect(step.run).toContain('node config/scripts/git-pull-request-diff-base.mjs "$BASE_SHA"')
  expect(step.run).toContain('git diff --name-only --no-renames -z "$DIFF_BASE" HEAD')
  expect(step.run).toContain(
    'git diff --name-only --no-renames --diff-filter=M -z "$DIFF_BASE" HEAD'
  )
  expect(step.run).toContain('git diff --raw --no-abbrev --no-renames -z "$DIFF_BASE" HEAD')
  expect(step.run).toContain(
    '--modified-paths "$RUNNER_TEMP/orcad-smoke-modified" --diff-paths "$RUNNER_TEMP/orcad-smoke-diff"'
  )
  expect(step.run).toContain('&& [ "$scope" = false ]; then')
  expect(step.run).toMatch(/else\s+pnpm run smoke:orcad-terminal\s+fi/)
})
