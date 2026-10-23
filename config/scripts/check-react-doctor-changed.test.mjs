import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runProcessSync } from '@orca/process-host'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { main } from './check-react-doctor-changed.mjs'
import { collectAddedLineRanges } from './check-changed-code-quality.mjs'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')
const script = path.join(repoRoot, 'config', 'scripts', 'check-react-doctor-changed.mjs')

function runWithBase(base) {
  return spawnSync(process.execPath, [script, base], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true
  })
}

describe('check-react-doctor-changed diff base', () => {
  // Invalid bases must fail before installing or running a tool.
  it.each(['main & calc', 'main | whoami', 'main"x', '%PATH%', 'main $(id)', '--help'])(
    'refuses %j',
    (base) => {
      const result = runWithBase(base)

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('Refusing to pass an unsafe diff base')
    }
  )
})

const temporaryRoots = []
const source = [
  "import { useState } from 'react'",
  '',
  'export function Counter() {',
  '  const [count, setCount] = useState(0)',
  '  function change() {',
  '    setCount((current) => {',
  "      localStorage.setItem('count', String(current))",
  '      return current + 1',
  '    })',
  '  }',
  '  return <button onClick={change}>{count}</button>',
  '}',
  ''
].join('\n')

function git(root, ...args) {
  const result = runProcessSync({
    program: 'git',
    args,
    cwd: root,
    timeoutMs: null,
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
  })
  if (result.code !== 0) {
    throw new Error(result.stderr)
  }
  return result.stdout.trim()
}

function createRepository() {
  const root = mkdtempSync(path.join(tmpdir(), 'orca-react-doctor-gate-'))
  temporaryRoots.push(root)
  git(root, 'init', '--quiet')
  git(root, 'config', 'user.email', 'test@example.com')
  git(root, 'config', 'user.name', 'Test')
  git(root, 'config', 'commit.gpgsign', 'false')
  const hooks = path.join(root, '.git', 'test-hooks')
  mkdirSync(hooks)
  git(root, 'config', 'core.hooksPath', hooks)
  writeFileSync(path.join(root, 'Counter.tsx'), source)
  git(root, 'add', '.')
  git(root, 'commit', '--quiet', '-m', 'base')
  return { root, base: git(root, 'rev-parse', 'HEAD') }
}

function report(root, file, line = 6, endLine = 9) {
  const diagnostic = {
    filePath: file,
    line,
    endLine,
    severity: 'error',
    plugin: 'react-doctor',
    rule: 'no-impure-state-updater',
    message: 'State updater has side effects'
  }
  return {
    schemaVersion: 3,
    mode: 'diff',
    ok: true,
    error: null,
    diagnostics: [diagnostic],
    projects: [{ packageRoot: root, complete: true, skippedChecks: [], diagnostics: [diagnostic] }]
  }
}

function runReport(root, base, value, overrides = {}) {
  return main(root, base, () => ({
    code: 0,
    signal: null,
    timedOut: false,
    stdout: JSON.stringify(value),
    stderr: '',
    ...overrides
  }))
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('React Doctor rename-aware changed-line gate', () => {
  it('does not treat an unchanged renamed updater as added when an import changes', () => {
    const { root, base } = createRepository()
    mkdirSync(path.join(root, 'nested folder'))
    const file = 'nested folder/Moved Counter.tsx'
    renameSync(path.join(root, 'Counter.tsx'), path.join(root, file))
    writeFileSync(path.join(root, file), source.replace("from 'react'", "from 'react-compatible'"))
    git(root, 'add', '.')

    expect(collectAddedLineRanges(root, base).rangesByFile.get(file)).toEqual([
      { start: 1, end: 1 }
    ])
    expect(runReport(root, base, report(root, file))).toBe(0)
  })

  it('blocks a new side effect inside an existing renamed updater span', () => {
    const { root, base } = createRepository()
    const file = 'MovedCounter.tsx'
    renameSync(path.join(root, 'Counter.tsx'), path.join(root, file))
    writeFileSync(
      path.join(root, file),
      source.replace(
        '      return current + 1',
        "      localStorage.setItem('new', 'effect')\n      return current + 1"
      )
    )
    git(root, 'add', '.')
    vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(runReport(root, base, report(root, file, 6, 10))).toBe(1)
  })

  it('blocks a copied violation while retaining the old file', () => {
    const { root, base } = createRepository()
    writeFileSync(
      path.join(root, 'CopiedCounter.tsx'),
      readFileSync(path.join(root, 'Counter.tsx'))
    )
    git(root, 'add', '.')
    vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(runReport(root, base, report(root, 'CopiedCounter.tsx'))).toBe(1)
  })

  it('blocks a new untracked file containing a violation', () => {
    const { root, base } = createRepository()
    writeFileSync(path.join(root, 'NewCounter.tsx'), source)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(runReport(root, base, report(root, 'NewCounter.tsx'))).toBe(1)
  })

  it.each(['cloud/Counter.tsx', 'page.html'])('retains React Doctor coverage for %s', (file) => {
    const { root, base } = createRepository()
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), source)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(runReport(root, base, report(root, file))).toBe(1)
  })

  it('resolves nested project diagnostics relative to their concrete package root', () => {
    const { root, base } = createRepository()
    mkdirSync(path.join(root, 'mobile'))
    writeFileSync(path.join(root, 'mobile/Counter.tsx'), source)
    const value = report(path.join(root, 'mobile'), 'Counter.tsx')
    vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(runReport(root, base, value)).toBe(1)
  })

  it.each([
    ['inconsistent diagnostics', (value) => ({ ...value, diagnostics: [] }), {}],
    ['malformed JSON', (value) => value, { stdout: '{' }],
    ['unsupported schema', (value) => ({ ...value, schemaVersion: 1 }), {}],
    ['failed report', (value) => ({ ...value, ok: false }), {}],
    ['missing diagnostics', (value) => ({ ...value, diagnostics: undefined }), {}],
    [
      'incomplete project',
      (value) => ({ ...value, projects: [{ ...value.projects[0], complete: false }] }),
      {}
    ],
    [
      'skipped project',
      (value) => ({ ...value, skippedProjects: [{ reason: 'max-duration' }] }),
      {}
    ],
    [
      'skipped lint',
      (value) => ({ ...value, projects: [{ ...value.projects[0], skippedChecks: ['lint'] }] }),
      {}
    ],
    ['degraded baseline', (value) => ({ ...value, baselineDegraded: true }), {}],
    [
      'invalid span',
      (value) => ({
        ...value,
        projects: [{ ...value.projects[0], diagnostics: [{ ...value.diagnostics[0], endLine: 1 }] }]
      }),
      {}
    ],
    ['crashed process', (value) => value, { code: 134 }],
    ['terminated process', (value) => value, { signal: 'SIGABRT' }],
    ['timed out process', (value) => value, { timedOut: true }],
    ['truncated output', (value) => value, { outputTruncated: true }]
  ])('fails closed on %s', (_label, change, overrides) => {
    const { root, base } = createRepository()
    expect(() => runReport(root, base, change(report(root, 'Counter.tsx')), overrides)).toThrow()
  })
})
