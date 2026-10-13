import { mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PluginEnvironmentProviderContextStore } from './plugin-environment-provider-context-store'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-provider-context-store-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
const binding = {
  executionHostId: 'local',
  providerId: 'company.platform/pods',
  contextId: 'company/team/account/region',
  sourceDigest: 'a'.repeat(64),
  recipeDigest: 'b'.repeat(64)
}
const filename = `${createHash('sha256').update(binding.providerId).digest('hex')}.json`
const directory = () => join(root, 'plugin-environment-provider-contexts')
const file = () => join(directory(), filename)

describe('durable host-selected provider account contexts', () => {
  it('enumerates durable selected accounts and refuses a valid record at a forged filename', async () => {
    const store = new PluginEnvironmentProviderContextStore(root)
    expect(await store.list()).toEqual([])
    const record = await store.configure(binding)
    expect(await store.list()).toEqual([record])
    await writeFile(join(directory(), `${'c'.repeat(64)}.json`), JSON.stringify(record))
    await expect(store.list()).rejects.toThrow('filename')
  })
  it('preserves an exact account binding across reopening without storing a launch environment', async () => {
    const store = new PluginEnvironmentProviderContextStore(root)
    expect(await store.read(binding.providerId)).toBeNull()
    const created = await store.configure(binding)
    expect(await new PluginEnvironmentProviderContextStore(root).read(binding.providerId)).toEqual(
      created
    )
    expect(await store.configure({ ...binding })).toEqual(created)
    expect(created).toEqual({ version: 1, binding, createdAt: expect.any(Number) })
    expect(await readdir(directory())).toEqual([filename])
  })
  it('serializes competing account setup so one provider cannot receive two inventory owners', async () => {
    const a = new PluginEnvironmentProviderContextStore(root)
    const b = new PluginEnvironmentProviderContextStore(root)
    const outcomes = await Promise.allSettled([
      a.configure(binding),
      b.configure({ ...binding, contextId: 'another-account' })
    ])
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter((r) => r.status === 'rejected')).toHaveLength(1)
    const record = await a.read(binding.providerId)
    expect([binding.contextId, 'another-account']).toContain(record?.binding.contextId)
  })
  it.each(['contextId', 'sourceDigest', 'recipeDigest'] as const)(
    'requires explicit migration for changed %s',
    async (field) => {
      const store = new PluginEnvironmentProviderContextStore(root)
      await store.configure(binding)
      await expect(
        store.configure({
          ...binding,
          [field]: field === 'contextId' ? 'other-account' : 'c'.repeat(64)
        })
      ).rejects.toThrow('migration')
      expect((await store.read(binding.providerId))?.binding).toEqual(binding)
    }
  )
  it('withdraws a captured configuration after replacement or corruption rather than falling back', async () => {
    const store = new PluginEnvironmentProviderContextStore(root)
    await store.configure(binding)
    const opened = await store.open(binding.providerId)
    expect(opened?.isCurrent()).toBe(true)
    await writeFile(
      file(),
      JSON.stringify({
        version: 1,
        binding: { ...binding, contextId: 'other-account' },
        createdAt: 0
      })
    )
    expect(opened?.isCurrent()).toBe(false)
    await writeFile(file(), '{broken')
    await expect(store.read(binding.providerId)).rejects.toThrow()
    await expect(store.configure(binding)).rejects.toThrow()
    await expect(store.list()).rejects.toThrow()
  })
  it('rejects unknown execution fields, oversize data and another provider at the stable path', async () => {
    const store = new PluginEnvironmentProviderContextStore(root)
    await store.configure(binding)
    await writeFile(
      file(),
      JSON.stringify({ version: 1, binding, createdAt: 0, env: { SECRET: 'must not be accepted' } })
    )
    await expect(store.read(binding.providerId)).rejects.toThrow()
    await writeFile(file(), ' '.repeat(4097))
    await expect(store.read(binding.providerId)).rejects.toThrow('4096')
    await writeFile(
      file(),
      JSON.stringify({
        version: 1,
        binding: { ...binding, providerId: 'other.platform/pods' },
        createdAt: 0
      })
    )
    await expect(store.read(binding.providerId)).rejects.toThrow('another provider')
  })
  it('refuses a dangling link as corruption rather than creating a new account record', async () => {
    const store = new PluginEnvironmentProviderContextStore(root)
    await store.configure(binding)
    await rm(file())
    try {
      await symlink(join(root, 'missing'), file())
    } catch (error) {
      if (
        process.platform === 'win32' &&
        error instanceof Error &&
        'code' in error &&
        error.code === 'EPERM'
      ) {
        return
      }
      throw error
    }
    await expect(store.read(binding.providerId)).rejects.toThrow()
    await expect(store.configure(binding)).rejects.toThrow()
    await expect(store.list()).rejects.toThrow('file type')
  })
})
