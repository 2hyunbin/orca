import { expect, onTestFinished, vi } from 'vitest'
import { createAgentModelCatalogService } from '../native-chat/agent-model-catalog/agent-model-catalog-service'
import { AgentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'

/** Independent discovery for the scripted runtime; the live chat never handles model/list. */
export function installScriptedCodexModelCatalog(sessionId: string, cwd: string, split = false) {
  const host = getStructuredAgentSessionHost()!
  const probe = vi.fn(async (modern = false) => ({
    origin: 'probe' as const,
    complete: true,
    models: (split ? [modern ? 'gpt-modern' : 'gpt-account', 'gpt-live'] : ['gpt-live']).map(
      (id, index) => ({
        id,
        label: id,
        isDefault: index === 0,
        efforts: [{ value: split ? (modern ? 'high' : 'low') : 'medium', label: 'Effort' }],
        serviceTiers:
          split && modern && id === 'gpt-live'
            ? []
            : [{ value: modern ? 'modern-speed' : 'priority', label: 'Fast' }]
      })
    )
  }))
  const discovery = Object.assign(async () => probe(), {
    resolve: async (_home: unknown, folder: string) => ({
      identity: folder,
      run: () => probe(split)
    }),
    resolveLegacy: async () => ({ identity: 'account', run: () => probe() })
  })
  const catalog = createAgentModelCatalogService({
    store: new AgentModelCatalogStore(),
    getRecord: (id) => host.deps.store.getRecord(id) ?? undefined,
    drivesRecord: () => true,
    resolveAccountHome: async () => host.deps.store.getRecord(sessionId)!.accountHome,
    recordWorkspacePath: async () => cwd,
    probes: { codex: discovery }
  })
  host.deps.modelCatalog = catalog
  onTestFinished(() => catalog.stop())
  return { probe, catalog }
}

export async function verifyScriptedCodexRecipientCatalogs(
  sessionId: string,
  cwd: string,
  mutate: (key: string, value: string, modern?: boolean) => Promise<unknown>
) {
  const host = getStructuredAgentSessionHost()!
  const { catalog, probe } = installScriptedCodexModelCatalog(sessionId, cwd, true)
  const accepted = async (key: string, value: string, modern = false) =>
    expect(await mutate(key, value, modern)).toMatchObject({ ok: true, result: { ok: true } })
  // Populate the scoped owner before any picker read; no last-reader index is involved.
  await catalog.read({ agent: 'codex', sessionId, legacy: true, waitForListing: true })
  await accepted('model', 'gpt-account')
  await accepted('serviceTier', 'priority')
  expect(catalog.peek(sessionId)).toBeNull()
  const modern = await host.readOptions(sessionId, {
    readsWithoutModel: true,
    readsCoherentCatalog: true
  })
  const legacy = await host.readOptions(sessionId, {
    readsWithoutModel: false,
    readsCoherentCatalog: false
  })
  expect(legacy.models[0]?.id).toBe('gpt-account')
  expect(modern.models[0]?.id).toBe('gpt-modern')
  expect(catalog.peek(sessionId)?.models[0]?.id).toBe('gpt-modern')
  const exact = catalog.peek(sessionId)
  const calls = probe.mock.calls.length
  for (const modernFirst of [true, false]) {
    for (const modernReader of [modernFirst, !modernFirst]) {
      await host.readOptions(sessionId, {
        readsWithoutModel: true,
        readsCoherentCatalog: modernReader
      })
    }
    await accepted('model', 'gpt-live')
    await accepted('effort', 'low')
    await accepted('model', 'gpt-live', true)
    await accepted('effort', 'high', true)
    await accepted('model', 'gpt-account')
    await accepted('model', 'gpt-account', true) // The current-only row remains selectable.
    await accepted('model', 'gpt-live')
    expect(await mutate('model', 'gpt-account', true)).toMatchObject({ result: { ok: false } })
    expect(await mutate('effort', 'high')).toMatchObject({ result: { ok: false } })
    expect(catalog.peek(sessionId)).toBe(exact)
  }
  expect(probe).toHaveBeenCalledTimes(calls)
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
