import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { runProcessSync } from '@orca/process-host'

it('audits downloaded full artifacts from a clean pinned checkout and rejects dirty or stale inputs', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-selection-scenarios-'))
  const repo = join(root, 'repo')
  const evidence = join(root, 'evidence')
  const shard = join(evidence, 'shard')
  const scenariosPath = join(root, 'scenarios.json')
  const git = (args) => {
    const result = runProcessSync({ program: 'git', args, cwd: repo })
    expect(result.code, result.stderr).toBe(0)
    return result.stdout.trim()
  }
  const audit = (cwd = repo) =>
    runProcessSync({
      program: process.execPath,
      args: [
        fileURLToPath(new URL('./ci-unit-selection-scenarios.mjs', import.meta.url)),
        evidence,
        scenariosPath
      ],
      cwd,
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
    })
  try {
    mkdirSync(join(repo, 'src'), { recursive: true })
    mkdirSync(shard, { recursive: true })
    writeFileSync(join(repo, 'src/value.ts'), 'export const value = 1')
    writeFileSync(join(repo, 'src/value.test.ts'), "import './value'")
    writeFileSync(join(repo, 'src/unrelated.test.ts'), 'export const unrelated = true')
    writeFileSync(join(repo, '.gitignore'), 'src/**/*.js\n')
    git(['init', '--quiet'])
    git(['add', 'src', '.gitignore'])
    git([
      '-c',
      'user.name=CI Test',
      '-c',
      'user.email=ci-test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      'fixture'
    ])
    const sourceSha = git(['rev-parse', 'HEAD'])
    const files = ['src/unrelated.test.ts', 'src/value.test.ts']
    const plan = {
      sourceSha,
      mode: 'shadow',
      selectionAvailable: false,
      files,
      candidateFiles: files,
      executionFiles: files
    }
    const timing = {
      sourceSha,
      runId: '1',
      runAttempt: '1',
      nodeVersion: '24',
      status: 'failed',
      unhandledErrors: 0,
      shard: { index: 1, count: 1 },
      timings: { 'src/unrelated.test.ts': 100, 'src/value.test.ts': 200 },
      results: { 'src/unrelated.test.ts': 'failed', 'src/value.test.ts': 'passed' }
    }
    writeFileSync(join(shard, 'unit-selection.json'), JSON.stringify(plan))
    writeFileSync(join(shard, 'unit-timings.json'), JSON.stringify(timing))
    writeFileSync(scenariosPath, JSON.stringify({ leaf: ['src/value.ts'] }))
    const result = audit()
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain('1/2 candidate files; selection evaluated; 1 failures outside')
    const report = JSON.parse(readFileSync(join(evidence, 'selection-scenarios.json'), 'utf8'))
    expect(report[0].references[0]).toMatchObject({
      sourceSha,
      completeFullRun: true,
      missedFailures: ['src/unrelated.test.ts']
    })

    writeFileSync(join(repo, 'src/value.ts'), 'export const value = 2')
    expect(audit().stderr).toContain('Commit or stash checkout changes')
    git(['checkout', '--', 'src/value.ts'])
    writeFileSync(join(repo, 'src/new.test.ts'), 'export const uncovered = true')
    expect(audit().stderr).toContain('Commit or stash checkout changes')
    rmSync(join(repo, 'src/new.test.ts'))
    writeFileSync(join(repo, 'src/generated.js'), 'export const stale = true')
    expect(audit().stderr).toContain('Untracked or ignored audit input: src/generated.js')
    rmSync(join(repo, 'src/generated.js'))
    expect(audit(join(repo, 'src')).stderr).toContain('Run from the repository root')

    writeFileSync(join(shard, 'unit-timings.json'), JSON.stringify({ ...timing, sourceSha: 'old' }))
    expect(audit().stderr).toContain('Evidence must match the checkout revision')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
