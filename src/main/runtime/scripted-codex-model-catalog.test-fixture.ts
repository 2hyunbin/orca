import { expect, onTestFinished, vi } from 'vitest'
import { createAgentModelCatalogService } from '../native-chat/agent-model-catalog/agent-model-catalog-service'
import { AgentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { agentModelCatalogFingerprint } from '../native-chat/agent-model-catalog/agent-model-catalog-fingerprint'

/** Independent discovery for the scripted runtime; the live chat never handles model/list. */
export function installScriptedCodexModelCatalog(sessionId: string, cwd: string) {
  const host = getStructuredAgentSessionHost()!
  const probe = vi.fn(async () => ({
    origin: 'probe' as const,
    complete: true,
    models: [
      {
        id: 'gpt-live',
        label: 'GPT Live',
        isDefault: true,
        efforts: [{ value: 'medium', label: 'Medium' }],
        serviceTiers: [{ value: 'priority', label: 'Fast' }]
      }
    ]
  }))
  const catalog = createAgentModelCatalogService({
    store: new AgentModelCatalogStore(),
    getRecord: (id) => host.deps.store.getRecord(id) ?? undefined,
    drivesRecord: () => true,
    resolveAccountHome: async () => host.deps.store.getRecord(sessionId)!.accountHome,
    recordWorkspacePath: async () => cwd,
    probes: { codex: probe }
  })
  host.deps.modelCatalog = catalog
  onTestFinished(() => catalog.stop())
  return { probe }
}

export async function verifyScriptedCodexRecipientCatalogs(
  sessionId: string,
  cwd: string,
  mutate: (key: string, value: string, modern?: boolean) => Promise<unknown>,
  reconcileAtNewTurn: () => Promise<void>
) {
  const host = getStructuredAgentSessionHost()!
  const gate = Promise.withResolvers<void>()
  let invocation = 'account'
  let probeCalls = 0
  const models = (modern: boolean) =>
    [modern ? 'gpt-modern' : 'gpt-account', 'gpt-live'].map((id, index) => ({
      id,
      label: id,
      isDefault: index === 0,
      efforts: [{ value: modern ? 'high' : 'low', label: 'Effort' }],
      serviceTiers:
        modern && id === 'gpt-live'
          ? []
          : [{ value: modern ? 'modern-speed' : 'priority', label: 'Fast' }]
    }))
  const probe = Object.assign(async () => ({ origin: 'probe' as const, models: [] }), {
    resolve: async (_home: unknown, folder: string) => ({
      identity: folder,
      run: async () => {
        probeCalls++
        await gate.promise
        return { origin: 'probe' as const, models: models(true), complete: true }
      }
    }),
    resolveLegacy: async () => ({
      identity: invocation,
      run: async () => {
        probeCalls++
        return {
          origin: 'probe' as const,
          models: models(false),
          complete: true
        }
      }
    })
  })
  const store = new AgentModelCatalogStore()
  const catalog = createAgentModelCatalogService({
    store,
    getRecord: (id) => host.deps.store.getRecord(id) ?? undefined,
    drivesRecord: () => true,
    resolveAccountHome: async () => host.deps.store.getRecord(sessionId)!.accountHome,
    recordWorkspacePath: async () => cwd,
    probes: { codex: probe }
  })
  host.deps.modelCatalog = catalog
  onTestFinished(() => {
    gate.resolve()
    catalog.stop()
  })
  const accepted = async (key: string, value: string, modern = false) =>
    expect(await mutate(key, value, modern)).toMatchObject({ ok: true, result: { ok: true } })
  // Populate the scoped owner before any picker read; no last-reader index is involved.
  await catalog.read({ agent: 'codex', sessionId, legacy: true, waitForListing: true })
  await accepted('model', 'gpt-account')
  await accepted('serviceTier', 'priority')
  expect(catalog.peek(sessionId)).toBeNull()
  for (let i = 0; i < 6; i++) {
    await catalog.read({ agent: 'codex', workspacePath: `/queued-${i}` })
  }
  let modernSettled = false
  const modern = host
    .readOptions(sessionId, { readsWithoutModel: true, readsCoherentCatalog: true })
    .then((answer) => {
      modernSettled = true
      return answer
    })
  const legacy = await host.readOptions(sessionId, {
    readsWithoutModel: false,
    readsCoherentCatalog: false
  })
  expect(legacy.models[0]?.id).toBe('gpt-account')
  expect(modernSettled).toBe(false)
  expect(catalog.peek(sessionId)).toBeNull()
  gate.resolve()
  expect((await modern).models[0]?.id).toBe('gpt-modern')
  expect(catalog.peek(sessionId)?.models[0]?.id).toBe('gpt-modern')
  const exact = catalog.peek(sessionId)
  const calls = probeCalls
  for (const modernFirst of [true, false]) {
    for (const modernReader of [modernFirst, !modernFirst]) {
      await host.readOptions(sessionId, {
        readsWithoutModel: true,
        readsCoherentCatalog: modernReader
      })
    }
    await accepted('model', 'gpt-live')
    await accepted('effort', 'low')
    await accepted('fastMode', 'true')
    await accepted('model', 'gpt-live', true)
    await accepted('effort', 'high', true)
    expect(host.deps.store.getRecord(sessionId)?.options?.serviceTier).toBe('priority')
    await accepted('model', 'gpt-modern', true)
    expect(host.deps.store.getRecord(sessionId)?.options?.serviceTier).toBe('default')
    await accepted('serviceTier', 'modern-speed', true)
    await accepted('model', 'gpt-account')
    await accepted('serviceTier', 'priority')
    await accepted('model', 'gpt-account', true) // The current-only row remains selectable.
    await accepted('model', 'gpt-live')
    expect(await mutate('model', 'gpt-account', true)).toMatchObject({ result: { ok: false } })
    expect(await mutate('effort', 'high')).toMatchObject({ result: { ok: false } })
    expect(await mutate('serviceTier', 'priority', true)).toMatchObject({ result: { ok: false } })
    expect(catalog.peek(sessionId)).toBe(exact)
  }
  await accepted('model', 'gpt-live')
  await accepted('serviceTier', 'priority')
  await reconcileAtNewTurn()
  invocation = 'changed-command-env'
  store.recordSuccess(
    agentModelCatalogFingerprint({
      agent: 'codex',
      accountHome: host.deps.store.getRecord(sessionId)!.accountHome,
      wslDistro: null
    }),
    'codex',
    { origin: 'probe', models: models(false) },
    'discovery'
  )
  await accepted('model', 'literal-unknown')
  await accepted('effort', 'literal-effort')
  await accepted('serviceTier', 'literal-tier')
  expect(await mutate('fastMode', 'true')).toMatchObject({ result: { ok: false } })
  await accepted('fastMode', 'false')
  expect(catalog.peek(sessionId)).toBe(exact)
  expect(probeCalls).toBe(calls)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const read = catalog.read
  vi.spyOn(catalog, 'read').mockImplementation(async (params) => {
    if (params.legacy && params.savedOnly) {
      entered.resolve()
      await release.promise
    }
    return read(params)
  })
  const apply = vi.spyOn(host.deps.adapter, 'setOption')
  const racing = mutate('serviceTier', 'priority')
  await entered.promise
  const closing = host.close(sessionId, 'user-close')
  release.resolve()
  await racing
  await closing
  expect(apply).not.toHaveBeenCalled()
}
