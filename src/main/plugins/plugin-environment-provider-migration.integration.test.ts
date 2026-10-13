import { randomUUID } from 'node:crypto'
import { readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createPluginEnvironmentProviderInstallFixture as fixture,
  disposePluginEnvironmentProviderInstallFixtures
} from './plugin-environment-provider-install-fixture'
import { pluginEnvironmentRecipeSchema } from '../../shared/plugins/plugin-environment-recipe-artifact'
import { environmentRecipeRequestSchema } from '../../shared/environment-recipe-protocol'
import { PluginEnvironmentRecipeJournalFile } from './plugin-environment-recipe-journal-file'
import { PluginEnvironmentRecipeJournalStore } from './plugin-environment-recipe-journal-store'
import { PluginEnvironmentProviderContextStore } from './plugin-environment-provider-context-store'
afterEach(disposePluginEnvironmentProviderInstallFixtures)
async function configured(retireConnections?: (providerId: string) => Promise<void>) {
  const f = await fixture({ recovery: true, retireConnections })
  await f.approve()
  await f.service.environmentProviders.configure(f.review)
  const list = environmentRecipeRequestSchema.parse({
    protocolVersion: 2,
    providerId: f.review.providerId,
    contextId: f.review.contextId,
    operationId: randomUUID(),
    action: 'list'
  })
  await f.service.environmentProviders.execute(f.review, list)
  return { ...f, list }
}
async function update(f: Awaited<ReturnType<typeof configured>>) {
  const path = join(f.sourceDir, 'recipe.json')
  const recipe = pluginEnvironmentRecipeSchema.parse(JSON.parse(await readFile(path, 'utf8')))
  recipe.commands.list.args.push('--', 'updated-provider')
  await writeFile(path, JSON.stringify(recipe))
  await f.reinstall()
  await f.approve()
  const entry = (await f.service.environmentProviders.list())[0]!
  return { ...entry.review, contextId: f.review.contextId }
}
describe('explicit provider migration selects a durable generation without overwriting old ownership', () => {
  it('reviews actual fresh inventory, preserves old history, selects one generation and executes there after restart', async () => {
    const f = await configured()
    const before = await f.service.environmentProviders.snapshot(f.review)
    const review = await update(f)
    const preview = await f.service.environmentProviders.prepareMigration('window-one', {
      review,
      queryId: randomUUID()
    })
    expect(preview.previousResources).toMatchObject([{ id: 'devbox' }])
    expect(preview.currentResources).toMatchObject([{ id: 'devbox' }])
    expect(preview.nextBinding.journalId).toBeTruthy()
    expect(
      (
        await new PluginEnvironmentProviderContextStore(f.service.options.userDataPath).read(
          review.providerId
        )
      )?.binding
    ).toEqual(before.binding)
    await expect(
      f.service.environmentProviders.commitMigration('other-window', { ticketId: preview.ticketId })
    ).rejects.toThrow('unavailable')
    await f.service.environmentProviders.commitMigration('window-one', {
      ticketId: preview.ticketId
    })
    const selected = await f.service.environmentProviders.snapshot(review)
    expect(selected.binding).toEqual(preview.nextBinding)
    expect(selected.previousBindings).toMatchObject([{ binding: before.binding }])
    expect(selected.operations[0]?.originBinding).toEqual(before.binding)
    expect(
      await new PluginEnvironmentRecipeJournalFile(
        f.service.options.userDataPath,
        before.binding
      ).read()
    ).toEqual(before)
    await f.service.dispose()
    const reopened = await f.reopen()
    expect(await reopened.environmentProviders.list()).toMatchObject([
      { configuration: { status: 'ready' } }
    ])
    expect(
      await reopened.environmentProviders.execute(review, { ...f.list, operationId: randomUUID() })
    ).toMatchObject({ kind: 'executed', result: { kind: 'completed' } })
  })
  it('preserves an unresolved mutation through a same-account source update and prevents a different account from inheriting it', async () => {
    const f = await configured()
    const original = environmentRecipeRequestSchema.parse({
      ...f.list,
      operationId: randomUUID(),
      action: 'create',
      parameters: {}
    })
    const before = await f.service.environmentProviders.snapshot(f.review)
    await new PluginEnvironmentRecipeJournalStore(
      f.service.options.userDataPath,
      before.binding
    ).begin(original)
    const review = await update(f)
    await expect(
      f.service.environmentProviders.prepareMigration('window-one', {
        review: { ...review, contextId: 'other-account' },
        queryId: randomUUID()
      })
    ).rejects.toThrow('Resolve')
    const preview = await f.service.environmentProviders.prepareMigration('window-one', {
      review,
      queryId: randomUUID()
    })
    expect(preview.unresolvedOperationIds).toEqual([original.operationId])
    await f.service.environmentProviders.commitMigration('window-one', {
      ticketId: preview.ticketId
    })
    await expect(
      f.service.environmentProviders.execute(review, { ...original, operationId: randomUUID() })
    ).rejects.toThrow('unresolved')
    expect(
      (await f.service.environmentProviders.snapshot(review)).operations.find(
        (op) => op.operationId === original.operationId
      )?.originBinding
    ).toEqual(before.binding)
  })
  it('separates identical machine IDs and revisions when the user explicitly changes backend account', async () => {
    const f = await configured()
    const old = await f.service.environmentProviders.snapshot(f.review)
    await f.selectBackendAccount('company/other-account')
    const review = { ...f.review, contextId: 'company/other-account' }
    const preview = await f.service.environmentProviders.prepareMigration('window-one', {
      review,
      queryId: randomUUID()
    })
    expect(preview.currentResources).toMatchObject([
      { id: 'devbox', revision: 'r1', name: 'Other account devbox' }
    ])
    await f.service.environmentProviders.commitMigration('window-one', {
      ticketId: preview.ticketId
    })
    expect((await f.service.environmentProviders.snapshot(review)).resources).toMatchObject([
      { name: 'Other account devbox' }
    ])
    expect(
      await new PluginEnvironmentRecipeJournalFile(
        f.service.options.userDataPath,
        old.binding
      ).read()
    ).toEqual(old)
    await expect(f.service.environmentProviders.execute(f.review, f.list)).rejects.toThrow(
      'configuration'
    )
  })
  it('refuses a changed journal or withdrawn review before selecting the new generation', async () => {
    const f = await configured()
    const review = await update(f)
    const preview = await f.service.environmentProviders.prepareMigration('window-one', {
      review,
      queryId: randomUUID()
    })
    const old = new PluginEnvironmentRecipeJournalStore(
      f.service.options.userDataPath,
      preview.previousBinding
    )
    await old.begin(environmentRecipeRequestSchema.parse({ ...f.list, operationId: randomUUID() }))
    await expect(
      f.service.environmentProviders.commitMigration('window-one', { ticketId: preview.ticketId })
    ).rejects.toThrow('history changed')
    expect(
      (
        await new PluginEnvironmentProviderContextStore(f.service.options.userDataPath).read(
          review.providerId
        )
      )?.binding
    ).toEqual(preview.previousBinding)
    const second = await f.service.environmentProviders.prepareMigration('window-one', {
      review,
      queryId: randomUUID()
    })
    f.service.environmentProviders.revokeMigrationOwner('window-one')
    await expect(
      f.service.environmentProviders.commitMigration('window-one', { ticketId: second.ticketId })
    ).rejects.toThrow('unavailable')
  })
  it('fails closed if the selected generation disappears and keeps the previous journal readable', async () => {
    const f = await configured()
    const review = await update(f)
    const preview = await f.service.environmentProviders.prepareMigration('window-one', {
      review,
      queryId: randomUUID()
    })
    await f.service.environmentProviders.commitMigration('window-one', {
      ticketId: preview.ticketId
    })
    await rm(
      new PluginEnvironmentRecipeJournalFile(f.service.options.userDataPath, preview.nextBinding)
        .filePath
    )
    expect(await f.service.environmentProviders.list()).toMatchObject([
      { configuration: { status: 'unavailable' } }
    ])
    await expect(f.service.environmentProviders.snapshot(review)).rejects.toThrow('missing')
    await expect(
      f.service.environmentProviders.execute(review, { ...f.list, operationId: randomUUID() })
    ).rejects.toThrow('missing')
    expect(
      await new PluginEnvironmentRecipeJournalFile(
        f.service.options.userDataPath,
        preview.previousBinding
      ).read()
    ).toMatchObject({ resources: [{ id: 'devbox' }] })
  })
  it('withdraws an already consuming review before it can select a generation', async () => {
    const f = await configured()
    const review = await update(f)
    const preview = await f.service.environmentProviders.prepareMigration('window-one', {
      review,
      queryId: randomUUID()
    })
    const committing = f.service.environmentProviders.commitMigration('window-one', {
      ticketId: preview.ticketId
    })
    f.service.environmentProviders.revokeMigrationOwner('window-one')
    await expect(committing).rejects.toThrow('authority changed')
    expect(
      (
        await new PluginEnvironmentProviderContextStore(f.service.options.userDataPath).read(
          review.providerId
        )
      )?.binding
    ).toEqual(preview.previousBinding)
  })
  it('keeps provider contact when stale history or withdrawn window authority refuses selection', async () => {
    const retire = vi.fn(async (_providerId: string) => {})
    const f = await configured(retire)
    const preview = await f.service.environmentProviders.prepareMigration('window-one', {
      review: f.review,
      queryId: randomUUID()
    })
    await new PluginEnvironmentRecipeJournalStore(
      f.service.options.userDataPath,
      preview.previousBinding
    ).begin(environmentRecipeRequestSchema.parse({ ...f.list, operationId: randomUUID() }))
    await expect(
      f.service.environmentProviders.commitMigration('window-one', { ticketId: preview.ticketId })
    ).rejects.toThrow('history changed')
    expect(retire).not.toHaveBeenCalled()
    const second = await f.service.environmentProviders.prepareMigration('window-one', {
      review: f.review,
      queryId: randomUUID()
    })
    const committing = f.service.environmentProviders.commitMigration('window-one', {
      ticketId: second.ticketId
    })
    f.service.environmentProviders.revokeMigrationOwner('window-one')
    await expect(committing).rejects.toThrow('authority changed')
    expect(retire).not.toHaveBeenCalled()
    expect(
      (
        await new PluginEnvironmentProviderContextStore(f.service.options.userDataPath).read(
          f.review.providerId
        )
      )?.binding
    ).toEqual(preview.previousBinding)
  })
  it('does not retire the newly selected account when a competing review already committed', async () => {
    const retire = vi.fn(async (_providerId: string) => {})
    const f = await configured(retire)
    const earlier = await f.service.environmentProviders.prepareMigration('window-one', {
      review: f.review,
      queryId: randomUUID()
    })
    const winner = await f.service.environmentProviders.prepareMigration('window-two', {
      review: f.review,
      queryId: randomUUID()
    })
    await f.service.environmentProviders.commitMigration('window-two', {
      ticketId: winner.ticketId
    })
    expect(retire).toHaveBeenCalledOnce()
    await expect(
      f.service.environmentProviders.commitMigration('window-one', { ticketId: earlier.ticketId })
    ).rejects.toThrow('no longer owns')
    expect(retire).toHaveBeenCalledOnce()
    expect((await f.service.environmentProviders.snapshot(f.review)).binding).toEqual(
      winner.nextBinding
    )
  })
})
