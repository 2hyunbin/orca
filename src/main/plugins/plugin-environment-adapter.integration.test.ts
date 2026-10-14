import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { environmentRecipeRequestSchema } from '../../shared/environment-recipe-protocol'
import {
  createPluginEnvironmentProviderInstallFixture as fixture,
  disposePluginEnvironmentProviderInstallFixtures
} from './plugin-environment-provider-install-fixture'

afterEach(disposePluginEnvironmentProviderInstallFixtures)
async function configured(options: NonNullable<Parameters<typeof fixture>[0]> = {}) {
  const f = await fixture({ portable: true, ...options })
  await f.approve()
  await f.service.environmentProviders.configure(f.review)
  return f
}
describe('reviewed repository adapters execute captured code through a host-owned Node runtime', () => {
  it('preserves a portable entry name and literal argv, including flags and shell metacharacters', async () => {
    const args = ['--inspect', 'with spaces', '$HOME', '$(touch injected)', '`touch injected`']
    const f = await configured({ portableArgs: args })
    await f.service.environmentProviders.execute(f.review, {
      protocolVersion: 2,
      contextId: f.review.contextId,
      providerId: f.review.providerId,
      operationId: randomUUID(),
      action: 'list'
    })
    expect(JSON.parse(await readFile(join(f.cwd, 'launch-info.json'), 'utf8'))).toEqual({
      argv: [process.execPath, 'provider.mjs', ...args]
    })
    await expect(readFile(join(f.cwd, 'injected'))).rejects.toThrow()
  })
  it('runs all six actions against an actual installed adapter and retains long-lived and ephemeral inventory', async () => {
    const runtime = vi.fn(async () => process.execPath)
    const f = await configured({ adapterRuntime: runtime })
    let revision: string | undefined
    for (const action of ['list', 'create', 'sleep', 'resume', 'archive', 'delete'] as const) {
      const request = environmentRecipeRequestSchema.parse({
        protocolVersion: 2,
        contextId: f.review.contextId,
        providerId: f.review.providerId,
        operationId: randomUUID(),
        action,
        ...(action === 'create' ? { parameters: {} } : {}),
        ...(revision && action !== 'list' && action !== 'create'
          ? { resourceId: 'sandbox', expectedRevision: revision }
          : {})
      })
      const result = await f.service.environmentProviders.execute(f.review, request)
      expect(result.kind).toBe('executed')
      if (result.kind !== 'executed') {
        throw new Error('The adapter operation was not executed')
      }
      expect(result.result.kind).toBe('completed')
      if (result.result.kind === 'completed' && result.result.response.kind === 'resource') {
        revision = result.result.response.resource.revision
      }
    }
    expect(runtime).toHaveBeenCalledTimes(6)
    const history = await f.service.environmentProviders.snapshot(f.review)
    expect(history.resources).toMatchObject([
      { id: 'devbox', lifetime: 'long-lived', state: 'running' },
      { id: 'sandbox', lifetime: 'ephemeral', state: 'deleted' }
    ])
    expect(history.operations).toHaveLength(6)
    await f.service.dispose()
    expect(await (await f.reopen()).environmentProviders.snapshot(f.review)).toEqual(history)
  })
  it('keeps captured reviewed bytes even if the original source directory changes', async () => {
    const f = await configured()
    await writeFile(
      join(f.sourceDir, 'provider.mjs'),
      'throw new Error("unreviewed original source")'
    )
    const result = await f.service.environmentProviders.execute(f.review, {
      protocolVersion: 2,
      contextId: f.review.contextId,
      providerId: f.review.providerId,
      operationId: randomUUID(),
      action: 'list'
    })
    expect(result).toMatchObject({
      kind: 'executed',
      result: { kind: 'completed', response: { kind: 'inventory' } }
    })
  })
  it('refuses changed installed adapter bytes before resolving any runtime or executing code', async () => {
    const runtime = vi.fn(async () => process.execPath)
    const f = await configured({ adapterRuntime: runtime })
    await writeFile(
      join(f.pluginDir, 'provider.mjs'),
      'throw new Error("changed installed source")'
    )
    await expect(
      f.service.environmentProviders.execute(f.review, {
        protocolVersion: 2,
        contextId: f.review.contextId,
        providerId: f.review.providerId,
        operationId: randomUUID(),
        action: 'list'
      })
    ).rejects.toThrow('changed')
    expect(runtime).not.toHaveBeenCalled()
    await expect(readFile(join(f.cwd, 'started'))).rejects.toThrow()
  })
  it('turns a known runtime preparation failure into a refusal without leaving an unresolved mutation', async () => {
    const f = await configured({
      adapterRuntime: async () => {
        throw new Error('Runtime is unavailable')
      }
    })
    const result = await f.service.environmentProviders.execute(f.review, {
      protocolVersion: 2,
      contextId: f.review.contextId,
      providerId: f.review.providerId,
      operationId: randomUUID(),
      action: 'create',
      parameters: {}
    })
    expect(result).toMatchObject({
      kind: 'executed',
      result: { kind: 'refused' },
      operation: { status: 'refused' }
    })
    await expect(readFile(join(f.cwd, 'started'))).rejects.toThrow()
  })
  it('passes cancellation to a waiting runtime and never starts the provider afterward', async () => {
    const entered = Promise.withResolvers<AbortSignal>(),
      release = Promise.withResolvers<void>()
    const f = await configured({
      adapterRuntime: async (signal) => {
        entered.resolve(signal)
        await release.promise
        return process.execPath
      }
    })
    const controller = new AbortController()
    const run = f.service.environmentProviders.execute(
      f.review,
      {
        protocolVersion: 2,
        contextId: f.review.contextId,
        providerId: f.review.providerId,
        operationId: randomUUID(),
        action: 'create',
        parameters: {}
      },
      controller.signal
    )
    const signal = await entered.promise
    controller.abort()
    expect(signal.aborted).toBe(true)
    release.resolve()
    expect(await run).toMatchObject({
      kind: 'executed',
      result: { kind: 'refused', reason: 'cancelled' }
    })
    await expect(readFile(join(f.cwd, 'started'))).rejects.toThrow()
  })
  it('retires authority during runtime preparation and refuses the delayed launch', async () => {
    const entered = Promise.withResolvers<AbortSignal>(),
      release = Promise.withResolvers<void>()
    const f = await configured({
      adapterRuntime: async (signal) => {
        entered.resolve(signal)
        await release.promise
        return process.execPath
      }
    })
    const run = f.service.environmentProviders.execute(f.review, {
      protocolVersion: 2,
      contextId: f.review.contextId,
      providerId: f.review.providerId,
      operationId: randomUUID(),
      action: 'list'
    })
    const signal = await entered.promise
    await f.disableProvider()
    expect(signal.aborted).toBe(true)
    release.resolve()
    expect(await run).toMatchObject({ kind: 'executed', result: { kind: 'refused' } })
    await expect(readFile(join(f.cwd, 'started'))).rejects.toThrow()
  })
  it('uses the same captured adapter for an explicit account migration inventory preview', async () => {
    const f = await configured()
    await f.selectBackendAccount('other-account')
    const preview = await f.service.environmentProviders.prepareMigration('window-one', {
      review: { ...f.review, contextId: 'other-account' },
      queryId: randomUUID()
    })
    expect(preview.currentResources).toMatchObject([{ id: 'devbox', name: 'Other account devbox' }])
    await f.service.environmentProviders.commitMigration('window-one', {
      ticketId: preview.ticketId
    })
    expect(
      await f.service.environmentProviders.snapshot({ ...f.review, contextId: 'other-account' })
    ).toMatchObject({ resources: [{ id: 'devbox', name: 'Other account devbox' }] })
  })
})
