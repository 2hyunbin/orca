import { afterEach, expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { agentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { agentModelCatalogFingerprintForRecord } from '../native-chat/agent-model-catalog/agent-model-catalog-fingerprint'
import { createAgentModelCatalogService } from '../native-chat/agent-model-catalog/agent-model-catalog-service'
import {
  captureHostShellEnvironment,
  createStructuredAgentEnvironmentResolvers,
  structuredAgentEnvironmentIdentity
} from './structured-agent-shell-environment'

const shell = vi.hoisted(
  (): {
    current: { PATH: string; IGNORED: string }
    next: { PATH: string; IGNORED: string }
    saved: string[]
    nextSaved: string[]
  } => ({
    current: { PATH: '/a', IGNORED: 'a' },
    next: { PATH: '/a', IGNORED: 'a' },
    saved: [],
    nextSaved: []
  })
)
vi.mock('../startup/login-shell-environment', () => ({
  resolveLoginShellEnvironment: async (options?: { startedAfter?: number }) => {
    if (options?.startedAfter !== undefined) {
      shell.current = { ...shell.next }
    }
    return { ...shell.current }
  }
}))
vi.mock('../pty/windows-environment-path', () => ({
  cachedPersistedWindowsPathSegments: () => shell.saved,
  readPersistedWindowsPathSegmentsAsync: async () => (shell.saved = [...shell.nextSaved]),
  mergePersistedWindowsPathAsync: async () => {}
}))

const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).forEach((stop) => stop())
  vi.restoreAllMocks()
  shell.current = { PATH: '/a', IGNORED: 'a' }
  shell.next = { ...shell.current }
  shell.saved = []
  shell.nextSaved = []
})

function rig() {
  const record = {
    ...agentSessionRecordFixture(),
    provider: 'grok',
    accountHome: { variable: 'GROK_HOME', path: '/catalog-refresh-fixture' }
  }
  const save = vi.fn()
  const defaults = vi.fn(async () => false)
  const service = createAgentModelCatalogService({
    store: agentModelCatalogStore,
    getRecord: (id) => (id === record.sessionId ? record : undefined),
    drivesRecord: () => true,
    resolveAccountHome: async () => record.accountHome,
    recordWorkspacePath: async () => '/workspace',
    workspaceMayOverrideDefaultModel: defaults
  })
  const environment = createStructuredAgentEnvironmentResolvers({
    resolveShellEnvironmentPolicy: () => ({ inheritAll: false, names: [] })
  })
  cleanups.push(service.stop, environment.bindCatalogSources(['grok']))
  const listing = (id: string) => ({
    models: [{ id, label: id, isDefault: true, efforts: [] }],
    configuredDefault: { modelId: id, effort: 'high' }
  })
  return {
    record,
    service,
    save,
    defaults,
    listing,
    fingerprint: agentModelCatalogFingerprintForRecord(record)
  }
}

it('retires a producer on effective Refresh before new publication and fences late defaults and new old reports', async () => {
  const h = rig()
  await agentModelCatalogStore.attachPersistence({
    load: async () => [],
    save: h.save,
    flush: async () => {}
  })
  const sourceA = h.service.captureSource(h.record)
  cleanups.push(() => sourceA.release?.())
  const heldDefault = Promise.withResolvers<boolean>()
  h.defaults.mockReturnValueOnce(heldDefault.promise)
  h.service.recordLiveListing(h.record.sessionId, h.listing('A'), sourceA)
  await vi.waitFor(() => expect(h.defaults).toHaveBeenCalledOnce())
  await captureHostShellEnvironment(async () => {
    shell.next = { PATH: '/b', IGNORED: 'a' }
  })
  expect(sourceA()).toBe(false)
  const sourceB = h.service.captureSource(h.record)
  cleanups.push(() => sourceB.release?.())
  h.service.recordLiveListing(h.record.sessionId, h.listing('B'), sourceB)
  await vi.waitFor(() => expect(agentModelCatalogStore.get(h.fingerprint)?.models[0]?.id).toBe('B'))
  const configured = vi.spyOn(agentModelCatalogStore, 'recordConfiguredDefault')
  heldDefault.resolve(false)
  await vi.waitFor(() =>
    expect(agentModelCatalogStore.get(h.fingerprint)?.configured?.modelId).toBe('B')
  )
  expect(configured.mock.calls.map((call) => call[1])).toEqual([{ modelId: 'B', effort: 'high' }])
  configured.mockClear()
  const before = JSON.stringify(agentModelCatalogStore.get(h.fingerprint))
  const writes = h.save.mock.calls.length
  const ingested = vi.spyOn(agentModelCatalogStore, 'recordSuccess')
  agentModelCatalogStore.recordFailure(h.fingerprint, 'current failure', 'grok')
  h.service.recordLiveListing(h.record.sessionId, h.listing('late A'), sourceA)
  h.service.providerStarted(h.record, sourceA)
  await vi.waitFor(() => expect(h.defaults).toHaveBeenCalledTimes(2))
  await Promise.resolve()
  expect(ingested).not.toHaveBeenCalled()
  expect(configured).not.toHaveBeenCalled()
  expect(JSON.stringify(agentModelCatalogStore.get(h.fingerprint))).toBe(before)
  expect(agentModelCatalogStore.failureDetail(h.fingerprint)).toBe('current failure')
  expect(h.save).toHaveBeenCalledTimes(writes)
})

it('preserves ignored inputs and other agent overlays, and releases only the exact registration', async () => {
  const h = rig()
  const source = h.service.captureSource(h.record)
  cleanups.push(() => source.release?.())
  let overlay = '/one'
  const other = createStructuredAgentEnvironmentResolvers({
    resolveShellEnvironmentPolicy: () => ({ inheritAll: true, names: [] }),
    resolveAgentLaunchEnv: () => ({ PATH: overlay })
  })
  const leaveOld = other.bindCatalogSources(['pi'])
  const leaveNew = other.bindCatalogSources(['pi'])
  leaveOld()
  cleanups.push(leaveNew)
  const piRevision = agentModelCatalogStore.retirementRevision('pi')
  await captureHostShellEnvironment(async () => {
    overlay = '/two'
    shell.next = { PATH: '/a', IGNORED: 'b' }
  })
  expect(source()).toBe(true)
  expect(agentModelCatalogStore.retirementRevision('pi')).toBe(piRevision + 1)
  leaveNew()
  await captureHostShellEnvironment(async () => {
    overlay = '/three'
  })
  expect(agentModelCatalogStore.retirementRevision('pi')).toBe(piRevision + 1)
  const injected = createStructuredAgentEnvironmentResolvers({
    resolveEnvironment: async () => ({ PATH: '/fixed' })
  })
  cleanups.push(injected.bindCatalogSources(['grok']))
  expect(await injected.resolveAgentEnvironment('grok')).toEqual({ PATH: '/fixed' })
})

it('keeps more than 256 live producer leases and releases a replaced source independently', () => {
  const service = createAgentModelCatalogService({
    store: agentModelCatalogStore,
    getRecord: () => undefined,
    drivesRecord: () => true,
    resolveAccountHome: async () => ({ variable: 'HOME', path: '/account' }),
    listsInChatFolder: new Set(['opencode'])
  })
  cleanups.push(service.stop)
  const record = agentSessionRecordFixture()
  const origin = { provider: 'opencode', location: record.location }
  const first = service.captureSource(origin)
  const replacement = service.captureSource(origin)
  const others = Array.from({ length: 257 }, (_, index) =>
    service.captureSource({
      ...origin,
      location: { ...origin.location, workspaceId: `other-workspace-${index}` }
    })
  )
  expect(first()).toBe(true)
  first.release?.()
  expect(first()).toBe(false)
  expect(replacement()).toBe(true)
  service.retireContext(record.location.workspaceId)
  expect(replacement()).toBe(false)
  expect(others.every((source) => source())).toBe(true)
  replacement.release?.()
  others.forEach((source) => source.release?.())
})

it('compares Windows effective key spelling and ignores a shadow Path value', () => {
  expect(
    structuredAgentEnvironmentIdentity({ Path: 'a', PATH: 'shadow', token: 'x' }, 'win32')
  ).toBe(structuredAgentEnvironmentIdentity({ PATH: 'a', TOKEN: 'x' }, 'win32'))
  expect(structuredAgentEnvironmentIdentity({ PATH: 'b', TOKEN: 'x' }, 'win32')).not.toBe(
    structuredAgentEnvironmentIdentity({ PATH: 'a', TOKEN: 'x' }, 'win32')
  )
})

it('freezes persisted Windows PATH before the detection callback refreshes its cache', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  cleanups.push(() => Object.defineProperty(process, 'platform', platform))
  shell.current = { PATH: 'C:\\shell', IGNORED: 'a' }
  shell.next = { ...shell.current }
  shell.saved = ['C:\\before']
  shell.nextSaved = [...shell.saved]
  const h = rig()
  const source = h.service.captureSource(h.record)
  cleanups.push(() => source.release?.())
  await captureHostShellEnvironment(async () => {
    shell.saved = ['C:\\after']
    shell.nextSaved = [...shell.saved]
  })
  expect(source()).toBe(false)
})
