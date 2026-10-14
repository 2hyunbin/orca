import { beforeAll, expect, it, vi } from 'vitest'
import { registerMainProcessIpcHandlers } from '../../../startup/main-process-ipc-bootstrap'
import {
  HOST_TEST_LOCATION,
  HOST_TEST_SESSION
} from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { editPersistedTestAgentSessionStore } from '../../agent-session-record-store-test-harness'
import {
  WORKTREE,
  call,
  createChat,
  directory,
  host,
  openHost,
  runtime,
  snapshot,
  store
} from './structured-chat-tab-table.test-fixture'

const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, () => Promise<unknown>>() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: () => Promise<unknown>) => handlers.set(name, handler)
  }
}))
vi.mock('../../../startup/main-process-state', () => ({
  mainProcessState: {
    get runtime() {
      return runtime
    },
    firstWindowStartupServicesReady: Promise.resolve(),
    managedWslCliStartupBarrierReady: Promise.resolve()
  }
}))
vi.mock('../../../startup/legacy-worker-renderer-recovery', () => ({
  recoverLegacyWorkerTerminalsForRendererStartup: vi.fn()
}))
vi.mock('../../../startup/startup-diagnostics', () => ({ logStartupMilestone: vi.fn() }))
vi.mock('../../../startup/os-opened-documents', () => ({ resolveOsOpenedDocuments: vi.fn() }))
vi.mock('../../saved-structured-agent-session-restoration', () => ({
  collectSavedStructuredAgentSessionIds: () => ['session-alpha', 'second-startup-entry-chat']
}))
beforeAll(registerMainProcessIpcHandlers)

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function prepareViaIpc() {
  const handler = handlers.get('app:prepareTerminalStartupRestoration')
  if (!handler) {
    throw new Error('startup handler missing')
  }
  return handler()
}
function controlPreparation() {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: controls only the existing persistence predicate and terminal census.
  const internal = runtime as unknown as {
    hasPersistedStructuredAgentSessionStore(): boolean
    refreshMobileSessionPtyRecords(): Promise<Set<string> | null>
  }
  vi.spyOn(internal, 'hasPersistedStructuredAgentSessionStore').mockReturnValue(true)
  vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue()
  return vi.spyOn(internal, 'refreshMobileSessionPtyRecords').mockResolvedValue(null)
}
async function saveChats(legacy = false) {
  for (const sessionId of legacy
    ? [HOST_TEST_SESSION, 'second-startup-entry-chat']
    : [HOST_TEST_SESSION]) {
    expect((await createChat(sessionId)).ok).toBe(true)
    await host.close(sessionId, 'user-close')
    runtime.retireStructuredAgentSessionTabFromSnapshot(sessionId)
  }
  if (legacy) {
    await editPersistedTestAgentSessionStore(directory, (persisted) => {
      delete persisted.sessionTabs
    })
    await openHost()
  }
}

it.each([
  { legacy: false, entry: 'IPC' },
  { legacy: true, entry: 'IPC' },
  { legacy: false, entry: 'public' },
  { legacy: true, entry: 'public' }
])(
  'the actual startup $entry owns restoration before close, legacy=$legacy',
  async ({ legacy, entry }) => {
    await saveChats(legacy)
    const reached = deferred()
    const release = deferred()
    controlPreparation().mockImplementationOnce(async () => {
      reached.resolve()
      await release.promise
      return null
    })
    const preparing =
      entry === 'IPC' ? prepareViaIpc() : runtime.prepareStructuredAgentSessionStartupRestoration()
    await reached.promise
    if (!legacy) {
      vi.spyOn(store, 'setSessionTabVisibility').mockRejectedValue(new Error('disk failure'))
    }
    try {
      expect(
        await call('session.tabs.close', {
          worktree: WORKTREE,
          tabId: `agent-session:${HOST_TEST_SESSION}`,
          reason: 'user'
        })
      ).toMatchObject({ ok: true, result: { closed: true } })
    } finally {
      release.resolve()
      await preparing
    }
    const first = runtime.restoreStructuredAgentSessionTabs()
    expect(runtime.restoreStructuredAgentSessionTabs()).toBe(first)
    await first
    expect((await snapshot()).tabs.map((tab) => tab.id)).toEqual(
      legacy ? ['agent-session:second-startup-entry-chat'] : []
    )
    if (legacy) {
      expect(store.listVisibleSessionIds()).toEqual(['second-startup-entry-chat'])
    }
  }
)

it('a close cancels the older windowless restore without a saved or live ghost, then reopens once', async () => {
  await saveChats(true)
  let layout: WorkspaceSessionState = {
    activeRepoId: null,
    activeWorktreeId: HOST_TEST_LOCATION.workspaceId,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {}
  }
  Object.assign(runtime, {
    getWorkspaceSessionForWorktree: () => layout,
    getWorkspaceSessionHostIdForWorktree: () => 'local',
    setWorkspaceSessionForWorktree: (_id: string, next: WorkspaceSessionState) => {
      layout = next
    }
  })
  const savedIds = () =>
    (layout.unifiedTabs?.[HOST_TEST_LOCATION.workspaceId] ?? []).map((tab) => tab.entityId)
  controlPreparation()
  const reached = deferred()
  const release = deferred()
  const history = host.restoreReadableSessions.bind(host)
  vi.spyOn(host, 'restoreReadableSessions').mockImplementationOnce(async (ids) => {
    reached.resolve()
    await release.promise
    await history(ids)
  })
  const restoring = runtime.restoreStructuredAgentSessionTabs()
  await reached.promise
  vi.spyOn(store, 'setSessionTabVisibility').mockRejectedValueOnce(new Error('disk failure'))
  try {
    expect(
      await call('session.tabs.close', {
        worktree: WORKTREE,
        tabId: `agent-session:${HOST_TEST_SESSION}`,
        reason: 'user'
      })
    ).toMatchObject({ ok: true, result: { closed: true } })
  } finally {
    release.resolve()
  }
  await restoring
  expect(savedIds()).toEqual(['second-startup-entry-chat'])
  expect((await snapshot()).tabs.map((tab) => tab.id)).toEqual([
    'agent-session:second-startup-entry-chat'
  ])
  expect(await call('agentSession.reveal', { sessionId: HOST_TEST_SESSION })).toMatchObject({
    ok: true,
    result: { ok: true }
  })
  expect(savedIds()).toEqual(['second-startup-entry-chat', HOST_TEST_SESSION])
  expect((await snapshot()).tabs.map((tab) => tab.id)).toEqual([
    'agent-session:second-startup-entry-chat',
    `agent-session:${HOST_TEST_SESSION}`
  ])
})
