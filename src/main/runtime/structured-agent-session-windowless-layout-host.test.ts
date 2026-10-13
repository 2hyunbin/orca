// A windowless host's saved chat tab against a real chat host: the index hiding a chat reaches the
// runtime and takes the tab out of the layout, and a chat whose record is gone loses its tab.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import { structuredAgentSessionTabId } from '../../shared/structured-agent-session-projection'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { closeTestJournalHostDatabases } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { recordingStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import { seedTestAgentSessionRecordStore } from './agent-session-record-store-test-harness'
import { OrcaRuntimeService } from './orca-runtime'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'

const WT = 'workspace-1'
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-windowless-chat-layout-'))
})

afterEach(async () => {
  await stopStructuredAgentSessionRuntime().catch(() => undefined)
  closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

function released(sessionId: string) {
  return agentSessionRecordFixture(
    agentSessionLeaseFixture({
      sessionId,
      ownerProcess: null,
      reservedSpawnToken: null,
      claimStatus: 'released'
    })
  )
}

/** A runtime with no window whose layout saves a tab for each chat. */
async function runtimeWithSavedChats(sessionIds: string[]) {
  const state: { session: WorkspaceSessionState } = {
    session: {
      activeRepoId: null,
      activeWorktreeId: WT,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {}
    }
  }
  const store = {
    getRepos: () => [],
    getSettings: () => ({}),
    getWorkspaceSession: () => state.session,
    getWorkspaceSessionHostIds: () => ['local' as const],
    setWorkspaceSession: (next: WorkspaceSessionState) => {
      state.session = next
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime reads only these store methods on these paths.
  const runtime = new OrcaRuntimeService(store as never)
  for (const sessionId of sessionIds) {
    await runtime.publishStructuredAgentSessionTab({
      workspaceId: WT,
      sessionId,
      agent: 'codex',
      activate: false
    })
  }
  return { runtime, state }
}

function installHost(runtime: OrcaRuntimeService) {
  return ensureStructuredAgentSessionHost({
    logger: recordingStructuredAgentSessionLogger().logger,
    stateDirectory: root,
    hostId: 'local',
    claimKeyId: 'key-1',
    resolveWorkspacePath: async () => root,
    resolveEnvironment: async () => ({}),
    resolveLaunchArgs: () => [],
    resolveClaudeAuthPolicy: () => ({ account: 'managed' }),
    onSessionTabHidden: (sessionId) => runtime.onStructuredSessionTabHidden(sessionId)
  })
}

function savedChatIds(state: { session: WorkspaceSessionState }): string[] {
  return (state.session.unifiedTabs?.[WT] ?? [])
    .filter((tab) => tab.contentType === 'agent-session')
    .map((tab) => tab.entityId)
}

describe('a windowless chat tab against the chat host', () => {
  it('leaves the layout when the host hides the chat', async () => {
    await seedTestAgentSessionRecordStore(root, {
      records: [released('chat-a'), released('chat-b')],
      sessionTabs: ['chat-a', 'chat-b'].map((sessionId) => ({
        tabId: structuredAgentSessionTabId(sessionId),
        sessionId
      }))
    })
    const { runtime, state } = await runtimeWithSavedChats(['chat-a', 'chat-b'])
    expect(savedChatIds(state)).toEqual(['chat-a', 'chat-b'])
    const host = await installHost(runtime)

    await host.setSessionTabVisibility('chat-a', false)

    expect(savedChatIds(state)).toEqual(['chat-b'])
  })

  it('leaves the layout at startup when the chat record is gone', async () => {
    await seedTestAgentSessionRecordStore(root, {
      records: [released('chat-b')],
      sessionTabs: [{ tabId: structuredAgentSessionTabId('chat-b'), sessionId: 'chat-b' }]
    })
    const { runtime, state } = await runtimeWithSavedChats(['chat-gone', 'chat-b'])
    expect(savedChatIds(state)).toEqual(['chat-gone', 'chat-b'])
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these are the runtime's own protected members; the test roots the host at `root` and stubs the PTY daemon.
    const internal = runtime as unknown as {
      hasPersistedStructuredAgentSessionStore(): boolean
      ensureStructuredAgentSessionHost(): Promise<unknown>
      refreshMobileSessionPtyRecords(): Promise<Set<string> | null>
    }
    internal.hasPersistedStructuredAgentSessionStore = () => true
    internal.ensureStructuredAgentSessionHost = () => installHost(runtime)
    internal.refreshMobileSessionPtyRecords = async () => new Set<string>()

    await runtime.restoreStructuredAgentSessionTabs()

    expect(savedChatIds(state)).toEqual(['chat-b'])
  })
})
