import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { environmentRecipeRequestSchema } from '../../shared/environment-recipe-protocol'
import { pluginEnvironmentRecipeSchema } from '../../shared/plugins/plugin-environment-recipe-artifact'
import { PluginEnvironmentRecipeJournalStore } from './plugin-environment-recipe-journal-store'
import { environmentRecipeDigest } from './plugin-environment-recipe-execution'
import { executeJournaledPluginEnvironmentRecipe } from './plugin-environment-recipe-operation'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journaled-operation-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
function input() {
  const recipe = pluginEnvironmentRecipeSchema.parse({
    schemaVersion: 1,
    id: 'devpods',
    name: 'Development pods',
    description: 'Private development pods',
    lifetime: 'both',
    commands: {
      list: { program: process.execPath, args: ['-e', 'process.exit(2)'] },
      create: { program: process.execPath, args: ['-e', 'process.exit(2)'] }
    }
  })
  return {
    userDataPath: root,
    executionHostId: 'local',
    sourceDigest: 'a'.repeat(64),
    pluginKey: 'company.platform',
    recipe,
    cwd: root,
    env: {},
    request: environmentRecipeRequestSchema.parse({
      protocolVersion: 1,
      operationId: randomUUID(),
      providerId: 'company.platform/devpods',
      action: 'create',
      parameters: {}
    }),
    authorize: vi.fn(async () => ({ isCurrent: () => true, signal: new AbortController().signal }))
  }
}
function journal(args: ReturnType<typeof input>) {
  return new PluginEnvironmentRecipeJournalStore(args.userDataPath, {
    executionHostId: args.executionHostId,
    providerId: args.request.providerId,
    sourceDigest: args.sourceDigest,
    recipeDigest: environmentRecipeDigest(args.recipe)
  })
}

describe('durable environment operation pipeline', () => {
  it('persists an intent before authorization and never executes an uncertain operation twice', async () => {
    const args = input()
    args.authorize.mockImplementation(async () => {
      const pending = (await journal(args).snapshot()).operations[0]
      expect(pending?.status).toBe('pending')
      expect(pending?.operationId).toBe(args.request.operationId)
      return { isCurrent: () => true, signal: new AbortController().signal }
    })
    const result = await executeJournaledPluginEnvironmentRecipe(args)
    expect(result.kind).toBe('executed')
    expect(result.operation.status).toBe('unverifiable')
    expect((await executeJournaledPluginEnvironmentRecipe(args)).kind).toBe('recorded')
    expect(args.authorize).toHaveBeenCalledTimes(1)
    const other = input()
    await expect(executeJournaledPluginEnvironmentRecipe(other)).rejects.toThrow('reconciled')
    expect(other.authorize).not.toHaveBeenCalled()
  })

  it('records refusal without spawning, then permits a separately approved operation', async () => {
    const args = input()
    const result = await executeJournaledPluginEnvironmentRecipe({
      ...args,
      authorize: async () => null
    })
    expect(result.operation.status).toBe('refused')
    const next = input()
    expect((await executeJournaledPluginEnvironmentRecipe(next)).operation.status).toBe(
      'unverifiable'
    )
    expect(next.authorize).toHaveBeenCalledTimes(1)
  })

  it('keeps an interrupted authorization pending and does not treat it as an expired lease', async () => {
    const args = input()
    const interrupted = {
      ...args,
      authorize: vi.fn(async () => {
        throw new Error('host disconnected')
      })
    }
    await expect(executeJournaledPluginEnvironmentRecipe(interrupted)).rejects.toThrow(
      'host disconnected'
    )
    expect((await journal(args).snapshot()).operations[0]?.status).toBe('pending')
    expect((await executeJournaledPluginEnvironmentRecipe(interrupted)).kind).toBe('recorded')
    expect(interrupted.authorize).toHaveBeenCalledTimes(1)
    await expect(executeJournaledPluginEnvironmentRecipe(input())).rejects.toThrow('pending')
  })

  it('rejects malformed creation and other-provider input before creating any intent', async () => {
    const invalid = input()
    invalid.recipe.createFields = [{ id: 'region', label: 'Region', required: true }]
    await expect(executeJournaledPluginEnvironmentRecipe(invalid)).rejects.toThrow('required')
    const other = input()
    other.request.providerId = 'other.platform/devpods'
    await expect(executeJournaledPluginEnvironmentRecipe(other)).rejects.toThrow('another provider')
    expect(invalid.authorize).not.toHaveBeenCalled()
    expect(other.authorize).not.toHaveBeenCalled()
    expect(await readdir(root)).toEqual([])
  })

  it('refuses changed executable and source before requesting another approval or running work', async () => {
    const args = input()
    await executeJournaledPluginEnvironmentRecipe({ ...args, authorize: async () => null })
    const changed = input()
    changed.recipe.commands.create!.args = ['--version']
    await expect(executeJournaledPluginEnvironmentRecipe(changed)).rejects.toThrow(
      'different source'
    )
    const replaced = { ...input(), sourceDigest: 'c'.repeat(64) }
    await expect(executeJournaledPluginEnvironmentRecipe(replaced)).rejects.toThrow(
      'different source'
    )
    expect(changed.authorize).not.toHaveBeenCalled()
    expect(replaced.authorize).not.toHaveBeenCalled()
  })
})
