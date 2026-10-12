import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ensureWindowsUserDataAclGrant,
  WINDOWS_ACL_GRANT_MARKER_FILE,
  WINDOWS_ACL_GRANT_SCHEME_VERSION,
  type WindowsAclGrantResult
} from './windows-user-data-acl'

function createFakeGrant(failing = new Set<string>()): {
  calls: string[]
  grantFn: (directory: string) => Promise<void>
} {
  const calls: string[] = []
  return {
    calls,
    grantFn: (directory) => {
      calls.push(directory)
      return failing.has(directory)
        ? Promise.reject(new Error('SetNamedSecurityInfoW failed with Win32 error 5'))
        : Promise.resolve()
    }
  }
}

function awaitResult(
  userDataPath: string,
  options: Parameters<typeof ensureWindowsUserDataAclGrant>[1]
): Promise<WindowsAclGrantResult> {
  return new Promise((resolve) => {
    ensureWindowsUserDataAclGrant(userDataPath, { ...options, onDone: resolve })
  })
}

function writeMarker(userDataPath: string, identity: string): void {
  writeFileSync(
    join(userDataPath, WINDOWS_ACL_GRANT_MARKER_FILE),
    JSON.stringify({ schemeVersion: WINDOWS_ACL_GRANT_SCHEME_VERSION, identity, grantedAt: 1 })
  )
}

const IDENTITY = '*S-1-5-21-1-2-3-1001'

describe('ensureWindowsUserDataAclGrant', () => {
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(os.tmpdir(), 'orca-acl-test-'))
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('grants each child directory, then the root, then writes the marker', async () => {
    mkdirSync(join(userDataPath, 'agent-hooks'))
    mkdirSync(join(userDataPath, 'codex-runtime-home'))
    // Files carry no inheritable rule to fix, so they are not touched.
    writeFileSync(join(userDataPath, 'orca-runtime.json'), '{}')
    const fake = createFakeGrant()

    const result = await awaitResult(userDataPath, { identity: IDENTITY, grantFn: fake.grantFn })

    expect(result).toEqual({ mode: 'granted' })
    expect(fake.calls.slice(0, -1).sort()).toEqual(
      [join(userDataPath, 'agent-hooks'), join(userDataPath, 'codex-runtime-home')].sort()
    )
    expect(fake.calls.at(-1)).toBe(userDataPath)
    const marker = JSON.parse(
      readFileSync(join(userDataPath, WINDOWS_ACL_GRANT_MARKER_FILE), 'utf-8')
    )
    expect(marker.schemeVersion).toBe(WINDOWS_ACL_GRANT_SCHEME_VERSION)
    expect(marker.identity).toBe(IDENTITY)
  })

  it('skips every grant when the marker matches the identity', async () => {
    writeMarker(userDataPath, IDENTITY)
    const fake = createFakeGrant()

    const result = await awaitResult(userDataPath, { identity: IDENTITY, grantFn: fake.grantFn })

    expect(result).toEqual({ mode: 'marker-hit' })
    expect(fake.calls).toHaveLength(0)
  })

  // An upgrade must not re-walk the whole userData tree just because the identity's spelling changed.
  it('accepts a marker written under the pre-native USERNAME identity', async () => {
    writeMarker(userDataPath, 'alice')
    const fake = createFakeGrant()

    const result = await awaitResult(userDataPath, {
      identity: IDENTITY,
      legacyIdentity: 'alice',
      grantFn: fake.grantFn
    })

    expect(result).toEqual({ mode: 'marker-hit' })
    expect(fake.calls).toHaveLength(0)
  })

  it('re-grants when the marker belongs to a different identity', async () => {
    writeMarker(userDataPath, '*S-1-5-21-9-9-9-1001')
    const fake = createFakeGrant()

    const result = await awaitResult(userDataPath, {
      identity: IDENTITY,
      legacyIdentity: 'alice',
      grantFn: fake.grantFn
    })

    expect(result).toEqual({ mode: 'granted' })
    expect(fake.calls).toEqual([userDataPath])
  })

  it('keeps going past a failed child, then withholds the marker so the next launch retries', async () => {
    const locked = join(userDataPath, 'locked')
    mkdirSync(locked)
    mkdirSync(join(userDataPath, 'fine'))
    const fake = createFakeGrant(new Set([locked]))

    const result = await awaitResult(userDataPath, { identity: IDENTITY, grantFn: fake.grantFn })

    expect(result).toMatchObject({ mode: 'failed', reason: expect.stringContaining('locked') })
    expect(fake.calls).toContain(userDataPath)
    expect(() => readFileSync(join(userDataPath, WINDOWS_ACL_GRANT_MARKER_FILE))).toThrow()
  })

  it('no-ops without a resolvable identity', async () => {
    const fake = createFakeGrant()

    const result = await awaitResult(userDataPath, { identity: null, grantFn: fake.grantFn })

    expect(result).toEqual({ mode: 'no-identity' })
    expect(fake.calls).toHaveLength(0)
  })

  it('ignores a corrupt marker and re-grants', async () => {
    writeFileSync(join(userDataPath, WINDOWS_ACL_GRANT_MARKER_FILE), '{not json')
    const fake = createFakeGrant()

    const result = await awaitResult(userDataPath, { identity: IDENTITY, grantFn: fake.grantFn })

    expect(result).toEqual({ mode: 'granted' })
  })
})
