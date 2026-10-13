import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readDaclOf } from './windows-dacl.test-fixture'
import {
  loadWindowsSecurity,
  WINDOWS_FILE_ALL_ACCESS,
  type WindowsSecurityAddon
} from './windows-security-addon'
import { removeTreeSync } from './windows-transient-lock-removal'

/**
 * The addon is Orca's own C++, so nothing upstream proves it moves DACLs the way the secure-file
 * policy assumes. These read every result back off a real NTFS volume.
 */
const describeOnWindows = process.platform === 'win32' ? describe : describe.skip

describeOnWindows('native windows-security addon against a real filesystem', () => {
  let addon: WindowsSecurityAddon
  let sid: string
  let root: string

  beforeAll(() => {
    const loaded = loadWindowsSecurity()
    if (!('addon' in loaded)) {
      throw new Error(`the windows-security addon did not load: ${loaded.error}`)
    }
    addon = loaded.addon
    sid = loaded.userSid
    root = mkdtempSync(join(tmpdir(), 'orca-windows-security-'))
  })

  afterAll(() => {
    removeTreeSync(root)
  })

  it('reports the token user as a domain-relative SID this process can use', () => {
    expect(sid).toMatch(/^S-1-5-21(?:-\d+){4}$/)
    const path = join(root, 'only-me.txt')
    addon.createFileWithDacl(path, `D:P(A;;FA;;;${sid})`, Buffer.from('mine'))
    // A DACL naming only that SID still lets this process read: it is our identity.
    expect(readFileSync(path, 'utf-8')).toBe('mine')
  })

  it('creates a file that is restricted from its first instant, contents intact', () => {
    const path = join(root, 'born.json')
    addon.createFileWithDacl(path, `D:P(A;;FA;;;SY)(A;;FA;;;${sid})`, Buffer.from('{"k":1}'))

    expect(readFileSync(path, 'utf-8')).toBe('{"k":1}')
    const dacl = readDaclOf(addon, path, sid)
    expect(dacl?.isProtected).toBe(true)
    expect(dacl?.aces.map((ace) => [ace.sid, ace.flags])).toEqual([
      ['S-1-5-18', []],
      [sid, []]
    ])
  })

  it('refuses to adopt an existing file, whose own DACL would survive', () => {
    const path = join(root, 'existing.json')
    writeFileSync(path, 'old')
    expect(() => addon.createFileWithDacl(path, `D:P(A;;FA;;;${sid})`, Buffer.from('new'))).toThrow(
      expect.objectContaining({ winCode: 80, syscall: 'CreateFileW' })
    )
    expect(readFileSync(path, 'utf-8')).toBe('old')
  })

  it('surfaces Win32 failures with their code instead of crashing', () => {
    expect(() => addon.getDaclSddl(join(root, 'missing'))).toThrow(
      expect.objectContaining({ winCode: 2, syscall: 'GetNamedSecurityInfoW' })
    )
    expect(() => addon.setDaclSddl(join(root, 'missing'), `D:P(A;;FA;;;${sid})`)).toThrow(
      expect.objectContaining({ winCode: 2 })
    )
    // A missing DACL means "everyone, full control"; the addon must never install one.
    const path = join(root, 'null-dacl.txt')
    writeFileSync(path, '')
    expect(() => addon.setDaclSddl(path, 'O:BA')).toThrow(
      expect.objectContaining({ winCode: 1338 })
    )
  })

  // Why it matters: hardening passes only explicit rules, and must never smuggle in a
  // parent's broader grant by echoing an inherited ACE back.
  it('drops inherited ACEs supplied to setDaclSddl and recomputes them from the parent', () => {
    const child = join(root, 'inheriting')
    mkdirSync(child)
    addon.setDaclSddl(child, `D:(A;OICI;FA;;;${sid})(A;OICIID;FA;;;WD)`)

    const dacl = readDaclOf(addon, child, sid)
    expect(dacl?.aces.some((ace) => ace.sid === 'S-1-1-0')).toBe(false)
    expect(dacl?.aces.some((ace) => ace.sid === sid && !ace.flags.includes('ID'))).toBe(true)
  })

  it('keeps canonical order when a grant lands beside an explicit deny', () => {
    const path = join(root, 'canonical.txt')
    writeFileSync(path, '')
    addon.setDaclSddl(path, 'D:AI(D;;FA;;;BG)(A;;FA;;;SY)')

    addon.grantAccess(path, sid, WINDOWS_FILE_ALL_ACCESS, { inheritable: false, replace: true })

    const aces = readDaclOf(addon, path, sid)?.aces ?? []
    const kinds = aces.map((ace) =>
      ace.flags.includes('ID') ? 'inherited' : ace.type === 'D' ? 'deny' : 'allow'
    )
    // Explicit deny, then explicit allows, then inherited: the order access checks rely on.
    expect(kinds.indexOf('deny')).toBe(0)
    expect(kinds.lastIndexOf('allow')).toBeLessThan(kinds.indexOf('inherited'))
    expect(aces).toContainEqual(expect.objectContaining({ type: 'A', sid, flags: [] }))
  })

  it('merges a grant without disturbing other principals or the protection state', () => {
    const path = join(root, 'merged.txt')
    writeFileSync(path, '')
    addon.setDaclSddl(path, `D:P(A;;FA;;;SY)(A;;FA;;;${sid})`)

    addon.grantAccess(path, 'S-1-15-2-2', 0x1200a9, { inheritable: false, replace: false })

    const dacl = readDaclOf(addon, path, sid)
    expect(dacl?.isProtected).toBe(true)
    expect(dacl?.aces.map((ace) => ace.sid).sort()).toEqual([sid, 'S-1-15-2-2', 'S-1-5-18'].sort())
  })

  // A NULL DACL already allows everyone; merging a grant into it would revoke every other principal.
  it('leaves a NULL DACL as it is when granting', () => {
    const path = join(root, 'null-dacl-grant.txt')
    addon.createFileWithDacl(path, 'D:NO_ACCESS_CONTROL', Buffer.from(''))
    expect(addon.getDaclSddl(path)).toBe('D:NO_ACCESS_CONTROL')

    addon.grantAccess(path, sid, WINDOWS_FILE_ALL_ACCESS, { inheritable: false, replace: true })

    expect(addon.getDaclSddl(path)).toBe('D:NO_ACCESS_CONTROL')
  })

  it('reaches a path longer than MAX_PATH', () => {
    let dir = join(root, 'long')
    while (dir.length < 280) {
      dir = join(dir, 'x'.repeat(40))
    }
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'secret.json')
    addon.createFileWithDacl(path, `D:P(A;;FA;;;${sid})`, Buffer.from('{}'))

    addon.grantAccess(path, 'S-1-5-18', WINDOWS_FILE_ALL_ACCESS, {
      inheritable: false,
      replace: false
    })

    expect(
      readDaclOf(addon, path, sid)
        ?.aces.map((ace) => ace.sid)
        .sort()
    ).toEqual(['S-1-5-18', sid].sort())
  })

  it('runs DACL writes on the thread pool and rejects with the Win32 code', async () => {
    const dir = join(root, 'async')
    mkdirSync(dir)
    await addon.setDaclSddlAsync(dir, `D:P(A;OICI;FA;;;${sid})`)
    expect(readDaclOf(addon, dir, sid)?.isProtected).toBe(true)

    await addon.grantAccessAsync(dir, 'S-1-5-18', WINDOWS_FILE_ALL_ACCESS, {
      inheritable: true,
      replace: true
    })
    expect(addon.getDaclSddl(dir)).toContain('(A;OICI;FA;;;SY)')

    await expect(
      addon.setDaclSddlAsync(join(root, 'missing-dir'), `D:P(A;;FA;;;${sid})`)
    ).rejects.toMatchObject({ winCode: 2 })
  })
})
