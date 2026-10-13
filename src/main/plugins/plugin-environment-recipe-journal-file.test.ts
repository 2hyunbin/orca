import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { PluginEnvironmentRecipeJournalFile } from './plugin-environment-recipe-journal-file'
import { environmentRecipeJournalSchema } from '../../shared/plugins/plugin-environment-recipe-journal'
const roots: string[] = []
const binding = {
  executionHostId: 'local',
  providerId: 'company.platform/pods',
  contextId: 'company/account',
  sourceDigest: 'a'.repeat(64),
  recipeDigest: 'b'.repeat(64)
}
async function root(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'orca-journal-generations-'))
  roots.push(directory)
  return directory
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})
it('opens an absent legacy journal but refuses an absent selected generation', async () => {
  const directory = await root()
  expect(await new PluginEnvironmentRecipeJournalFile(directory, binding).read()).toMatchObject({
    resources: [],
    operations: []
  })
  await expect(
    new PluginEnvironmentRecipeJournalFile(directory, {
      ...binding,
      journalId: randomUUID()
    }).read()
  ).rejects.toThrow('missing')
})
it('preserves separate old and new journals and refuses writes to a different generation', async () => {
  const directory = await root()
  const oldFile = new PluginEnvironmentRecipeJournalFile(directory, binding)
  const old = environmentRecipeJournalSchema.parse({
    version: 1,
    binding,
    resources: [
      {
        id: 'box',
        name: 'Old account box',
        state: 'running',
        lifetime: 'long-lived',
        revision: 'r1'
      }
    ],
    operations: []
  })
  oldFile.write(old)
  const nextBinding = { ...binding, contextId: 'other/account', journalId: randomUUID() }
  const nextFile = new PluginEnvironmentRecipeJournalFile(directory, nextBinding)
  const next = environmentRecipeJournalSchema.parse({
    version: 1,
    binding: nextBinding,
    resources: [{ ...old.resources[0], name: 'New account box' }],
    operations: [],
    previousBindings: [{ binding, archivedAt: 1 }]
  })
  expect(() => nextFile.write(old)).toThrow('another generation')
  nextFile.write(next)
  expect(await oldFile.read()).toEqual(old)
  expect(await nextFile.read()).toEqual(next)
})
it('rejects history references and operation origins from another provider or account', () => {
  const journal = { version: 1, binding, resources: [], operations: [] }
  expect(() =>
    environmentRecipeJournalSchema.parse({
      ...journal,
      previousBindings: [
        { binding: { ...binding, providerId: 'other.platform/pods' }, archivedAt: 1 }
      ]
    })
  ).toThrow('another provider')
  expect(() =>
    environmentRecipeJournalSchema.parse({
      ...journal,
      operations: [
        {
          operationId: randomUUID(),
          requestDigest: 'c'.repeat(64),
          action: 'create',
          startedAt: 1,
          status: 'pending',
          originBinding: { ...binding, contextId: 'other/account' }
        }
      ]
    })
  ).toThrow('another account')
})
