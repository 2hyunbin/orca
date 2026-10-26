import { afterEach, expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../../shared/agent-session-record.test-fixture'
import { OrcaRuntimeWithStructuredSessionAccountHome } from './structured-session-account-home'
import { installClaudeProfileRouter } from '../../claude-accounts/claude-profile-installed-router'
import { onRunningAccount } from '../../native-chat/agent-model-catalog/agent-model-catalog-running-account'
import { structuredAgentRuntimeMetadata } from '../structured-agent-runtime-metadata'
import { createAgentModelCatalogService } from '../../native-chat/agent-model-catalog/agent-model-catalog-service'
import { agentDrivesSession } from '../../native-chat/agent-session-wire/structured-agent-session-provider-support'
import { claudeAndCodexAgents } from '../../native-chat/agent-session-wire/structured-agent-session-adapter-router-test-support'
import { AgentModelCatalogStore } from '../../native-chat/agent-model-catalog/agent-model-catalog-store'

vi.mock('./structured-session-cli-writer-host', () => ({
  OrcaRuntimeWithStructuredSessionCliWriterHost: class {}
}))
afterEach(() => installClaudeProfileRouter(undefined))

it('without a router keeps the founding home through the real runtime and catalog account resolver', async () => {
  installClaudeProfileRouter(undefined)
  const getSettings = vi.fn(() => {
    throw new Error('a pinned read must not inspect local settings')
  })
  const runtime: OrcaRuntimeWithStructuredSessionAccountHome = Object.assign(
    Object.create(OrcaRuntimeWithStructuredSessionAccountHome.prototype),
    { requireStore: () => ({ getSettings }) }
  )
  const record = agentSessionRecordFixture()
  const result = await onRunningAccount(
    { launchAccountHome: runtime.resolveStructuredAgentLaunchAccountHome.bind(runtime) },
    record
  )
  expect(result).toBe(record)
  expect(result.accountHome).toEqual(record.accountHome)
  expect(getSettings).not.toHaveBeenCalled()
})

it.each([
  { executionHostId: 'ssh:remote', wslDistro: null },
  { executionHostId: 'local', wslDistro: 'Ubuntu' }
])(
  'unsupported $executionHostId/$wslDistro never probes or mutates the local catalog',
  async (location) => {
    const record = {
      ...agentSessionRecordFixture(),
      location: { ...agentSessionRecordFixture().location, ...location }
    }
    expect(structuredAgentRuntimeMetadata('claude')!.supportsLocation(record.location)).toBe(false)
    const probe = vi.fn()
    const store = new AgentModelCatalogStore()
    const write = vi.spyOn(store, 'recordSuccess')
    const resolveAccountHome = vi.fn(async () => record.accountHome)
    const service = createAgentModelCatalogService({
      store,
      getRecord: () => record,
      drivesRecord: (entry) => agentDrivesSession(claudeAndCodexAgents(), entry),
      resolveAccountHome,
      probes: { claude: probe }
    })
    expect(
      await service.read({ agent: 'claude', sessionId: record.sessionId, waitForListing: true })
    ).toEqual({ origin: 'unknown' })
    expect(probe).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
    expect(resolveAccountHome).not.toHaveBeenCalled()
    service.stop()
  }
)
