import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { eraseRpcMethods, type RpcContext } from '../core'
import { PLUGIN_ENVIRONMENT_PROVIDER_METHODS } from './plugin-environment-providers'
import { setPluginServiceForRpc } from './plugins'
import { PLUGIN_ENVIRONMENT_PROVIDER_RUNTIME_CAPABILITY } from '../../../../shared/plugins/plugin-environment-provider-runtime-capability'
import { environmentRecipeRequestSchema } from '../../../../shared/environment-recipe-protocol'
import {
  createPluginEnvironmentProviderInstallFixture,
  disposePluginEnvironmentProviderInstallFixtures
} from '../../../plugins/plugin-environment-provider-install-fixture'

const methods = eraseRpcMethods(PLUGIN_ENVIRONMENT_PROVIDER_METHODS)
function method(name: string) {
  const found = methods.find((entry) => entry.name === `plugins.environments.${name}`)
  if (!found || 'stream' in found) {
    throw new Error('Missing ordinary provider method')
  }
  return found
}
function context(connectionId = 'socket-one', overrides: Partial<RpcContext> = {}): RpcContext {
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: These handlers read only getRuntimeId; the fixture supplies that method and the authenticated socket contract.
    runtime: { getRuntimeId: () => 'host-runtime' } as RpcContext['runtime'],
    connectionId,
    clientId: 'same-paired-device',
    clientKind: 'runtime',
    signal: new AbortController().signal,
    clientCapabilities: [PLUGIN_ENVIRONMENT_PROVIDER_RUNTIME_CAPABILITY],
    ...overrides
  }
}
function call(name: string, params: unknown, rpcContext: RpcContext) {
  const entry = method(name)
  return entry.handler(
    entry.params
      ? entry.params.parse({
          runtimeId: 'host-runtime',
          ...(params === undefined ? {} : { input: params })
        })
      : undefined,
    rpcContext
  )
}
async function fixture(
  options: Parameters<typeof createPluginEnvironmentProviderInstallFixture>[0] = {}
) {
  const f = await createPluginEnvironmentProviderInstallFixture({ portable: true, ...options })
  setPluginServiceForRpc(f.service)
  return f
}
afterEach(async () => {
  setPluginServiceForRpc(null)
  await disposePluginEnvironmentProviderInstallFixtures()
})

describe('paired provider RPC preserves execution-host ownership and account approval', () => {
  it('requires live negotiated runtime sockets for every host-admin method', async () => {
    const f = await fixture()
    for (const entry of methods) {
      expect(entry.permission).toBe('host-admin')
    }
    for (const overrides of [
      { clientKind: 'mobile' as const },
      { connectionId: undefined },
      { clientId: undefined },
      { signal: undefined },
      { clientCapabilities: [] },
      { signal: AbortSignal.abort() }
    ]) {
      await expect(async () =>
        call('list', undefined, context('socket-one', overrides))
      ).rejects.toThrow()
    }
    expect(await call('list', undefined, context())).toEqual([])
    await expect(async () =>
      method('list').handler({ runtimeId: 'another-host' }, context())
    ).rejects.toThrow('another control host')
    await expect(readFile(join(f.cwd, 'started'))).rejects.toThrow()
  })
  it('configures host-owned accounts without code execution and rejects injected control-host state', async () => {
    const f = await fixture()
    const caller = context()
    await expect(async () => call('configure', f.review, caller)).rejects.toThrow('approval')
    await f.approve()
    for (const injected of [
      { cwd: '/other-host' },
      { env: { SECRET: 'injected' } },
      { executionHostId: 'foreign' }
    ]) {
      await expect(async () =>
        call('configure', { ...f.review, ...injected }, caller)
      ).rejects.toThrow()
    }
    expect(await call('configure', f.review, caller)).toMatchObject([
      { configuration: { status: 'ready', contextId: f.review.contextId } }
    ])
    await expect(readFile(join(f.cwd, 'started'))).rejects.toThrow()
  })
  it('executes all six actions through the installed host adapter and durable inventory', async () => {
    const f = await fixture()
    await f.approve()
    const caller = context()
    await call('configure', f.review, caller)
    let revision: string | undefined
    for (const action of ['list', 'create', 'sleep', 'resume', 'archive', 'delete'] as const) {
      const request = environmentRecipeRequestSchema.parse({
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
      const result = await call('execute', { review: f.review, request }, caller)
      expect(result).toMatchObject({ kind: 'executed', result: { kind: 'completed' } })
      const saved = await f.service.environmentProviders.snapshot(f.review)
      revision = saved.resources.find((entry) => entry.id === 'sandbox')?.revision
    }
    expect(await call('snapshot', f.review, caller)).toMatchObject({
      resources: [
        { id: 'devbox', lifetime: 'long-lived', state: 'running' },
        { id: 'sandbox', lifetime: 'ephemeral', state: 'deleted' }
      ]
    })
  })
  it('isolates cancellation across sockets of the same device and retains a lost mutation for receipt recovery', async () => {
    const f = await fixture({ recovery: true, loseCreateResponse: true })
    await f.approve()
    const disconnected = new AbortController()
    const caller = context('socket-one', { signal: disconnected.signal })
    const other = context('socket-two')
    await call('configure', f.review, caller)
    const request = environmentRecipeRequestSchema.parse({
      protocolVersion: 2,
      contextId: f.review.contextId,
      providerId: f.review.providerId,
      operationId: randomUUID(),
      action: 'create',
      parameters: {}
    })
    const pending = call('execute', { review: f.review, request }, caller)
    await expect
      .poll(async () => {
        try {
          return JSON.parse(await readFile(join(f.cwd, 'receipts.json'), 'utf8'))[
            request.operationId
          ]?.outcome?.kind
        } catch {
          return null
        }
      })
      .toBe('completed')
    expect(await call('cancel', { operationId: request.operationId }, other)).toBe(false)
    disconnected.abort()
    expect(await pending).toMatchObject({
      kind: 'executed',
      result: { kind: 'unverifiable', reason: 'cancelled' }
    })
    expect(await call('snapshot', f.review, other)).toMatchObject({
      operations: [{ status: 'unverifiable' }]
    })
    await expect(async () => call('list', undefined, caller)).rejects.toThrow()
    expect(
      await call(
        'recover',
        { review: f.review, originalOperationId: request.operationId, queryId: randomUUID() },
        other
      )
    ).toMatchObject({
      kind: 'inspected',
      result: { kind: 'completed', response: { kind: 'receipt' } }
    })
    expect(await call('execute', { review: f.review, request }, other)).toMatchObject({
      kind: 'recorded'
    })
  })
})
