import { PluginEnvironmentRecipeJournalFile } from '../plugins/plugin-environment-recipe-journal-file'
import { randomUUID } from 'node:crypto'
import { NODE_RUNTIME_PIN } from '../../shared/node-runtime-pin'
import { environmentRecipeRequestSchema } from '../../shared/environment-recipe-protocol'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as runtimeCapabilities from '../../shared/remote-runtime-client-capabilities'
import { Store } from '../persistence'
import { OrcadRuntimeLifetime } from './orcad-runtime-lifetime'
import { startOrcadPlugins } from './orcad-plugins'
import { PluginKillListService } from '../plugins/plugin-kill-list-service'
import { getPluginsDataDir } from '../plugins/plugin-discovery'
import {
  createPluginEnvironmentProviderInstallFixture,
  disposePluginEnvironmentProviderInstallFixtures
} from '../plugins/plugin-environment-provider-install-fixture'
import { pairedRuntimeRpcFixture } from '../runtime/runtime-paired-rpc-test-fixture'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { PLUGIN_ENVIRONMENT_PROVIDER_RUNTIME_CAPABILITY } from '../../shared/plugins/plugin-environment-provider-runtime-capability'
import { unwrapRuntimeRpcResult } from '../../shared/runtime-rpc-result'
import { environmentProviderRpcAvailable } from '../runtime/rpc/methods/plugin-environment-provider-service'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
  await disposePluginEnvironmentProviderInstallFixtures()
})

async function fixture(
  options: Parameters<typeof createPluginEnvironmentProviderInstallFixture>[0] = {}
) {
  const f = await createPluginEnvironmentProviderInstallFixture({ portable: true, ...options })
  await f.service.dispose()
  const store = new Store({
    dataFile: join(f.root, 'profile.json'),
    serializedState: JSON.stringify({ settings: { pluginSystemEnabled: true } })
  })
  const lifetime = new OrcadRuntimeLifetime()
  lifetime.add(() => store.freezeWritesAsync())
  cleanups.push(() => lifetime.stop())
  const service = await startOrcadPlugins({
    store,
    userDataPath: f.service.options.userDataPath,
    hostVersion: '1.4.0',
    registerCleanup: (cleanup) => lifetime.add(cleanup),
    safetyList: new PluginKillListService({
      pluginsDataDir: getPluginsDataDir(f.service.options.userDataPath),
      fetcher: async () => ({ version: 1, generatedAt: new Date().toISOString(), plugins: [] })
    }),
    launchEnvironment: f.service.options.getEnvironmentRecipeLaunchEnvironment
  })
  return { ...f, store, service, lifetime }
}

describe('Node control-host plugin composition uses its profile and authenticated runtime transport', () => {
  it('discovers installed providers, records consent through real paired RPC and withdraws capability on shutdown', async () => {
    const f = await fixture()
    const host = await pairedRuntimeRpcFixture(cleanups, new OrcaRuntimeService(f.store), f.root)
    const connection = host.connect([PLUGIN_ENVIRONMENT_PROVIDER_RUNTIME_CAPABILITY])
    const request = async (name: string, input?: unknown) => {
      const response = await connection.request(
        `plugins.environments.${name}`,
        {
          runtimeId: host.runtime.getRuntimeId(),
          ...(input === undefined ? {} : { input })
        },
        15000
      )
      return unwrapRuntimeRpcResult(response)
    }
    expect(environmentProviderRpcAvailable()).toBe(true)
    expect(await request('list')).toEqual([])
    const plugin = f.service.findValidPlugin('company.platform')
    if (!plugin?.reviewRevision) {
      throw new Error('Provider not discovered on the Node host')
    }
    unwrapRuntimeRpcResult(
      await connection.request(
        'plugins.consent',
        {
          pluginKey: plugin.pluginKey,
          reviewedFingerprint: plugin.consentFingerprint,
          reviewedRevision: plugin.reviewRevision,
          decision: 'approve'
        },
        5000
      )
    )
    expect(f.store.getSettings().pluginConsents).toMatchObject({
      'company.platform': plugin.consentFingerprint
    })
    expect(await request('configure', f.review)).toMatchObject([
      { configuration: { status: 'ready' } }
    ])
    await expect(readFile(join(f.cwd, 'started'))).rejects.toThrow()
    let revision: string | undefined
    for (const action of ['list', 'create', 'sleep', 'resume', 'archive', 'delete'] as const) {
      const operation = environmentRecipeRequestSchema.parse({
        protocolVersion: 2,
        contextId: f.review.contextId,
        providerId: f.review.providerId,
        operationId: randomUUID(),
        action,
        ...(action === 'create' ? { parameters: {} } : {}),
        ...(revision && action !== 'create' && action !== 'list'
          ? { resourceId: 'sandbox', expectedRevision: revision }
          : {})
      })
      expect(await request('execute', { review: f.review, request: operation })).toMatchObject({
        kind: 'executed',
        result: { kind: 'completed' }
      })
      revision = (await f.service.environmentProviders.snapshot(f.review)).resources.find(
        (resource) => resource.id === 'sandbox'
      )?.revision
    }
    expect(await request('snapshot', f.review)).toMatchObject({
      resources: [
        { id: 'devbox', state: 'running' },
        { id: 'sandbox', state: 'deleted' }
      ]
    })
    const invocations = (await readFile(join(f.cwd, 'invocations.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(invocations).toHaveLength(6)
    expect(
      invocations.every((invocation) => invocation.version === `v${NODE_RUNTIME_PIN.version}`)
    ).toBe(true)
    expect(
      unwrapRuntimeRpcResult(await connection.request('status.get', undefined, 5000))
    ).toMatchObject({
      capabilities: expect.arrayContaining([PLUGIN_ENVIRONMENT_PROVIDER_RUNTIME_CAPABILITY])
    })
    const oldRuntime = await connection.request(
      'plugins.environments.configure',
      {
        runtimeId: 'previous-server-instance',
        input: f.review
      },
      5000
    )
    expect(oldRuntime).toMatchObject({ ok: false })
    const unsupported = host.connect([])
    const currentCapabilities = runtimeCapabilities.remoteRuntimeClientCapabilities
    const legacyCapabilities = vi
      .spyOn(runtimeCapabilities, 'remoteRuntimeClientCapabilities')
      .mockImplementation((additional) =>
        currentCapabilities(additional).filter(
          (capability) => capability !== PLUGIN_ENVIRONMENT_PROVIDER_RUNTIME_CAPABILITY
        )
      )
    expect(
      await unsupported.request(
        'plugins.environments.list',
        {
          runtimeId: host.runtime.getRuntimeId()
        },
        5000
      )
    ).toMatchObject({ ok: false })
    legacyCapabilities.mockRestore()
    f.store.updateSettings({ pluginSystemEnabled: false }, { notifyListeners: true })
    await f.service.whenReady()
    expect(await request('list')).toEqual([])
    await f.lifetime.stop()
    expect(environmentProviderRpcAvailable()).toBe(false)
    expect(
      unwrapRuntimeRpcResult(await connection.request('status.get', undefined, 5000))
    ).toMatchObject({
      capabilities: expect.not.arrayContaining([PLUGIN_ENVIRONMENT_PROVIDER_RUNTIME_CAPABILITY])
    })
    await expect(request('list')).rejects.toThrow()
  })
  it('keeps a disconnected applied mutation fenced and isolates another socket before authoritative receipt recovery', async () => {
    const f = await fixture({ recovery: true, loseCreateResponse: true })
    const host = await pairedRuntimeRpcFixture(cleanups, new OrcaRuntimeService(f.store), f.root)
    const original = host.connect([PLUGIN_ENVIRONMENT_PROVIDER_RUNTIME_CAPABILITY])
    const sibling = host.connect([PLUGIN_ENVIRONMENT_PROVIDER_RUNTIME_CAPABILITY])
    const rpc = async (connection: typeof original, name: string, input?: unknown) =>
      unwrapRuntimeRpcResult(
        await connection.request(
          `plugins.environments.${name}`,
          { runtimeId: host.runtime.getRuntimeId(), ...(input === undefined ? {} : { input }) },
          15000
        )
      )
    const plugin = f.service.findValidPlugin('company.platform')
    if (!plugin?.reviewRevision) {
      throw new Error('Provider not discovered')
    }
    unwrapRuntimeRpcResult(
      await original.request(
        'plugins.consent',
        {
          pluginKey: plugin.pluginKey,
          reviewedFingerprint: plugin.consentFingerprint,
          reviewedRevision: plugin.reviewRevision,
          decision: 'approve'
        },
        5000
      )
    )
    await rpc(original, 'configure', f.review)
    const operation = environmentRecipeRequestSchema.parse({
      protocolVersion: 2,
      providerId: f.review.providerId,
      contextId: f.review.contextId,
      operationId: randomUUID(),
      action: 'create',
      parameters: {}
    })
    const pending = rpc(original, 'execute', { review: f.review, request: operation }).then(
      (result) => ({ kind: 'completed', result }),
      (error: unknown) => ({ kind: 'unavailable', error })
    )
    await expect
      .poll(
        async () => {
          try {
            return JSON.parse(await readFile(join(f.cwd, 'receipts.json'), 'utf8'))[
              operation.operationId
            ]?.outcome?.kind
          } catch {
            return null
          }
        },
        { timeout: 10000 }
      )
      .toBe('completed')
    expect(await rpc(sibling, 'cancel', { operationId: operation.operationId })).toBe(false)
    original.close()
    expect(await pending).toMatchObject({ kind: 'unavailable' })
    await expect
      .poll(
        async () => (await f.service.environmentProviders.snapshot(f.review)).operations[0]?.status,
        { timeout: 10000 }
      )
      .toBe('unverifiable')
    expect(
      await rpc(sibling, 'recover', {
        review: f.review,
        originalOperationId: operation.operationId,
        queryId: randomUUID()
      })
    ).toMatchObject({
      kind: 'inspected',
      result: { kind: 'completed', response: { kind: 'receipt' } }
    })
    expect(await rpc(sibling, 'execute', { review: f.review, request: operation })).toMatchObject({
      kind: 'recorded'
    })
    const invocations = (await readFile(join(f.cwd, 'invocations.jsonl'), 'utf8'))
      .trim()
      .split('\n')
    expect(invocations).toHaveLength(2)
  })
  it('waits for an interrupted adapter and its durable journal before releasing the Node profile', async () => {
    const f = await fixture({ recovery: true, loseCreateResponse: true })
    const host = await pairedRuntimeRpcFixture(cleanups, new OrcaRuntimeService(f.store), f.root)
    const connection = host.connect([PLUGIN_ENVIRONMENT_PROVIDER_RUNTIME_CAPABILITY])
    const request = async (name: string, input: unknown) =>
      unwrapRuntimeRpcResult(
        await connection.request(
          `plugins.environments.${name}`,
          { runtimeId: host.runtime.getRuntimeId(), input },
          15000
        )
      )
    const plugin = f.service.findValidPlugin('company.platform')
    if (!plugin?.reviewRevision) {
      throw new Error('Provider not discovered')
    }
    unwrapRuntimeRpcResult(
      await connection.request(
        'plugins.consent',
        {
          pluginKey: plugin.pluginKey,
          reviewedFingerprint: plugin.consentFingerprint,
          reviewedRevision: plugin.reviewRevision,
          decision: 'approve'
        },
        5000
      )
    )
    await request('configure', f.review)
    const operation = environmentRecipeRequestSchema.parse({
      protocolVersion: 2,
      providerId: f.review.providerId,
      contextId: f.review.contextId,
      operationId: randomUUID(),
      action: 'create',
      parameters: {}
    })
    const pending = request('execute', { review: f.review, request: operation })
    const settled = pending.then(
      (result) => ({ kind: 'completed', result }),
      (error: unknown) => ({ kind: 'unavailable', error })
    )
    await expect
      .poll(
        async () => {
          try {
            return JSON.parse(await readFile(join(f.cwd, 'receipts.json'), 'utf8'))[
              operation.operationId
            ]?.outcome?.kind
          } catch {
            return null
          }
        },
        { timeout: 10000 }
      )
      .toBe('completed')
    const before = await f.service.environmentProviders.snapshot(f.review)
    await f.lifetime.stop()
    expect(await settled).toMatchObject({
      kind: 'completed',
      result: { kind: 'executed', result: { kind: 'unverifiable' } }
    })
    const saved = await new PluginEnvironmentRecipeJournalFile(
      f.service.options.userDataPath,
      before.binding
    ).read()
    expect(saved?.operations).toMatchObject([
      { operationId: operation.operationId, status: 'unverifiable', reason: 'authority-changed' }
    ])
    expect(environmentProviderRpcAvailable()).toBe(false)
    const adapterPid = Number(await readFile(join(f.cwd, 'started'), 'utf8'))
    expect(() => process.kill(adapterPid, 0)).toThrow()
  })
  it('rejects mobile callers at the dispatcher before provider execution', async () => {
    const f = await fixture()
    const host = await pairedRuntimeRpcFixture(
      cleanups,
      new OrcaRuntimeService(f.store),
      f.root,
      'mobile'
    )
    const connection = host.connect([PLUGIN_ENVIRONMENT_PROVIDER_RUNTIME_CAPABILITY])
    const response = await connection.request(
      'plugins.environments.list',
      {
        runtimeId: host.runtime.getRuntimeId()
      },
      5000
    )
    expect(response).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    await expect(readFile(join(f.cwd, 'started'))).rejects.toThrow()
  })
})
