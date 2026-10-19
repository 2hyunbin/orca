import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { getDefaultSettings } from '../../../../shared/constants'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../shared/agent-session-record.test-fixture'
import type { AgentSessionRecordStore } from '../../../runtime/agent-session-record-store'
import { ManagedConversationStarts } from '../../../runtime/managed-conversation-starts'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { finishPtyShutdown } from '../provider/liveness'
import { admitColdRestoreReattach } from '../host-env/saved-resume-admission'
import type { PtyRuntimeControllerDeps } from './controller-deps'
import { prepareRuntimePtySpawn } from './spawn-preflight'
import { createRuntimePtySpawnState } from './spawn-state'

const forgetRefusedPaneResume = vi.hoisted(() => vi.fn())
vi.mock('../../../agent-hooks/server', () => ({ agentHookServer: { forgetRefusedPaneResume } }))

const C = 'provider-session-alpha-1'
const chat = agentSessionRecordFixture(
  agentSessionLeaseFixture({
    claimStatus: 'released',
    ownerProcess: null,
    reservedSpawnToken: null,
    deathEvidence: { kind: 'exit-observed', detail: 'closed', observedAt: 1 }
  })
)

const store = {
  listRecords: () => [chat],
  getVisibleSessionTabIndex: () => ({ present: true, sessionIds: [chat.sessionId] })
}

/** A host whose one chat continues C at rest, with its tab open. */
function chatHost() {
  const starts = new ManagedConversationStarts()
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the admission reads only the two members `store` has.
    openAgentSessionRecordStore: async () => store as unknown as AgentSessionRecordStore,
    reserveManagedConversationStart: vi.fn(starts.reserve.bind(starts)),
    forgetRefusedSavedResume: vi.fn(async () => {}),
    getAgentProviderSessionRows: () => [
      { paneKey: 'tab-1:leaf', agentType: 'claude', providerSession: { key: 'session_id', id: C } }
    ]
  }
}

function deps(runtime: ReturnType<typeof chatHost>): PtyRuntimeControllerDeps {
  const noCodexResumeLaunch: PtyRuntimeControllerDeps['noCodexResumeLaunch'] = (command) => ({
    codexResumeHome: null,
    command,
    notifyResumeUnavailable: false,
    droppedResumeArgv: false,
    providerSession: null
  })
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the preflight reads only the admission members `chatHost` provides.
    runtime: runtime as unknown as OrcaRuntimeService,
    store: undefined,
    getSettings: () => getDefaultSettings('/tmp'),
    adoptStablePane: async () => null,
    getLocalPtyStartupPromise: () => undefined,
    getLocalPtyProviderStartupPromise: () => undefined,
    prepareCodexResumeHome: () => null,
    resolveCodexResumeLaunch: async (command) => noCodexResumeLaunch(command),
    noCodexResumeLaunch,
    reconcileSharedRuntimeResumeHome: async (resumeHome) => resumeHome.codexHomePath,
    stripSequencedStartupResumeArgv: (env) => env,
    assertWorkspaceAcceptsNewPty: () => undefined,
    resolvePtySpawnStartupCwd: (_worktreeId, cwd) => cwd,
    requestSerializedBuffer: async () => null,
    shutdownProviderAndDetectExit: async () => false,
    rememberSyntheticKillExit: () => {},
    rememberRetiredRejectedPty: () => {},
    sendPtyExitToRenderer: () => {},
    sendPtySpawnedToRenderer: () => {},
    finishPtyShutdown,
    trustedTerminalHandleEnv: new Set(),
    retiredRejectedPtyIds: new Map(),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the spawn preflight never touches `mainWindow`.
    mainWindow: {} as BrowserWindow
  }
}

describe('host-side saved resumes of a conversation an open chat continues', () => {
  it('materializes a phone-restored pane as a plain shell and forgets its saved record', async () => {
    const runtime = chatHost()
    const ctx = createRuntimePtySpawnState(deps(runtime), {
      cols: 80,
      rows: 24,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: '11111111-1111-4111-8111-111111111111',
      command: `claude --resume ${C}`,
      launchAgent: 'claude',
      resumeProviderSession: { key: 'session_id', id: C },
      resumeOrigin: 'saved'
    })
    await prepareRuntimePtySpawn(ctx)
    ctx.finishTerminalInstall()
    expect(ctx.args.command).toBeUndefined()
    expect(ctx.launchCommand ?? '').not.toContain(C)
    expect(runtime.forgetRefusedSavedResume).toHaveBeenCalledWith(
      'wt-1',
      'tab-1:11111111-1111-4111-8111-111111111111',
      { agent: 'claude', providerSession: { key: 'session_id', id: C } }
    )
  })

  it("refuses a late reattach's cold restore before its window can resume it", async () => {
    const runtime = chatHost()
    await expect(
      admitColdRestoreReattach(
        runtime,
        { coldRestore: { scrollback: '', cwd: '/tmp' } },
        { paneKey: 'tab-1:leaf', saved: undefined },
        null
      )
    ).resolves.toMatchObject({ verdict: 'chat-home' })
    expect(runtime.reserveManagedConversationStart).not.toHaveBeenCalled()
  })
})
