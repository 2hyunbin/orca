import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const restricted = vi.hoisted((): string[] => [])
vi.mock('../shared/secure-path-windows-acl', () => ({
  restrictWindowsPathSync: (path: string) => {
    restricted.push(path)
    return true
  }
}))

describe('writeCredentialFileAtomic on Windows', () => {
  const platform = process.platform
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform })
  })

  it('restricts the staged file before it replaces the credential', async () => {
    const { writeCredentialFileAtomic } = await import('./integration-credential-file')
    const dir = mkdtempSync(join(tmpdir(), 'credential-acl-'))
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      const target = join(dir, 'linear-token.enc')
      writeCredentialFileAtomic(target, Buffer.from('token'))
      expect(restricted[0]).toMatch(/linear-token\.enc\..+\.tmp$/)
      expect(restricted).toContain(target)
    } finally {
      Object.defineProperty(process, 'platform', { value: platform })
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
