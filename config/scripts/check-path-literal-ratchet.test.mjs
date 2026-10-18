import { describe, expect, it } from 'vitest'

import {
  createPathResolver,
  extractPathLiterals,
  isScannedPath
} from './check-path-literal-ratchet.mjs'

describe('extractPathLiterals', () => {
  it('reads quoted literals, relative imports and pathspec globs in code', () => {
    const text = [
      "const a = 'src/main/ssh/ssh-connection.ts'",
      "import { b } from '../../src/shared/protocol-version'",
      "await import('./src/main/ssh/relay.ts')",
      "git diff -- ':(glob)src/shared/windows-*'",
      '// src/main/ipc/pty.ts is prose, not a reference'
    ].join('\n')
    expect(extractPathLiterals('config/scripts/route.mjs', text)).toEqual([
      { literal: 'src/main/ssh/ssh-connection.ts', isImport: false },
      { literal: 'src/shared/protocol-version', isImport: true },
      { literal: 'src/main/ssh/relay.ts', isImport: true },
      { literal: 'src/shared/windows-', isImport: false }
    ])
  })

  it('reads unquoted command arguments in manifests and workflows', () => {
    const text = '"command": "pnpm test src/main/a.test.ts src/renderer/src/b.test.ts"'
    expect(extractPathLiterals('config/reliability-gates.jsonc', text)).toEqual([
      { literal: 'src/main/a.test.ts', isImport: false },
      { literal: 'src/renderer/src/b.test.ts', isImport: false }
    ])
    expect(extractPathLiterals('.github/workflows/x.yml', "  - 'src/main/ssh/**'\n")).toEqual([
      { literal: 'src/main/ssh/', isImport: false }
    ])
  })

  it('ignores paths outside the app source roots', () => {
    expect(
      extractPathLiterals('config/x.mjs', "'src/lib/downloadTargets.ts' 'mobile/src/a.ts'")
    ).toEqual([])
  })
})

describe('isScannedPath', () => {
  it('skips unit tests, fixtures and generated timings, but scans e2e specs', () => {
    expect(isScannedPath('config/scripts/pr-e2e-source-routing.mjs')).toBe(true)
    expect(isScannedPath('.github/workflows/pr.yml')).toBe(true)
    expect(isScannedPath('tests/e2e/ssh-orcad-terminal-journeys.spec.ts')).toBe(true)
    expect(isScannedPath('config/scripts/pr-e2e-source-routing.test.mjs')).toBe(false)
    expect(isScannedPath('tests/e2e/helpers/pr-comments-sidebar-fixture.ts')).toBe(false)
    expect(isScannedPath('config/scripts/ci-shard-timings.json')).toBe(false)
    expect(isScannedPath('config/patches/foo.patch')).toBe(false)
  })
})

describe('createPathResolver', () => {
  const resolves = createPathResolver([
    'src/main/ssh/ssh-connection.ts',
    'src/main/ssh/ssh-types.test.ts'
  ])

  it('accepts a file, an extensionless import, a folder and a prefix', () => {
    expect(resolves('src/main/ssh/ssh-connection.ts')).toBe(true)
    expect(resolves('src/main/ssh/ssh-connection')).toBe(true)
    expect(resolves('src/main/ssh/')).toBe(true)
    expect(resolves('src/main/ssh/ssh-')).toBe(true)
  })

  it('flags a literal whose file moved', () => {
    expect(resolves('src/main/ssh/connection/ssh-connection.ts')).toBe(false)
    expect(resolves('src/main/managed-server/')).toBe(false)
  })

  it('resolves an import exactly, so a same-prefix sibling cannot hide a moved module', () => {
    expect(resolves('src/main/ssh/ssh-connection', true)).toBe(true)
    expect(resolves('src/main/ssh/ssh-types', true)).toBe(false)
    expect(resolves('src/main/ssh/ssh-types')).toBe(true)
  })
})
