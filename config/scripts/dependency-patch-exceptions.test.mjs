import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyAdvisoryExceptionPatches } from './dependency-patch-exceptions.mjs'

const directories = []
afterEach(() =>
  directories.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
)

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-advisory-patch-'))
  directories.push(root)
  writeFileSync(join(root, 'security.patch'), 'reviewed fix\n')
  writeFileSync(
    join(root, 'pnpm-workspace.yaml'),
    'patchedDependencies:\n  example@1.0.0: security.patch\n'
  )
  const policy = {
    advisoryExceptions: [
      {
        workspace: '.',
        package: 'example',
        version: '1.0.0',
        patch: {
          path: 'security.patch',
          sha256: createHash('sha256').update('reviewed fix\n').digest('hex')
        }
      }
    ]
  }
  return { root, policy }
}

describe('patch-backed advisory exceptions', () => {
  it('requires the reviewed bytes and an exact pnpm patch registration', () => {
    const { root, policy } = fixture()
    expect(() => verifyAdvisoryExceptionPatches(policy, '.', root)).not.toThrow()
    writeFileSync(join(root, 'security.patch'), 'different fix\n')
    expect(() => verifyAdvisoryExceptionPatches(policy, '.', root)).toThrow('patch changed')
  })

  it.each(['{}', 'patchedDependencies:\n  example@2.0.0: security.patch\n'])(
    'rejects a removed or retargeted patch',
    (manifest) => {
      const { root, policy } = fixture()
      writeFileSync(join(root, 'pnpm-workspace.yaml'), manifest)
      expect(() => verifyAdvisoryExceptionPatches(policy, '.', root)).toThrow(
        'requires installed patch'
      )
    }
  )

  it('checks only the workspace being released', () => {
    const { root, policy } = fixture()
    rmSync(join(root, 'security.patch'))
    expect(() => verifyAdvisoryExceptionPatches(policy, 'cloud', root)).not.toThrow()
    expect(() => verifyAdvisoryExceptionPatches(policy, '.', root)).toThrow()
  })
})
