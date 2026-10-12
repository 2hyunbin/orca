// issue1-ui-flash (host half): `session.tabs` must not manufacture completion or
// freshness. A neutral live title ('Terminal', an editor, a cwd) is not proof the
// agent finished, and the identity-only fallback must date its evidence instead of
// the byte stream — otherwise the host frame is perpetually newer than a paired
// client's own live status and the pane flaps between the two writers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { makePaneKey } from '../../shared/stable-pane-id'
import { getDefaultSettings, getDefaultWorkspaceSession } from '../../shared/constants'
import type { TerminalTab } from '../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const TAB_ID = 'remote-tab'
const WORKTREE_ID = 'wt-1'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)
const PTY_ID = 'pty-remote'
const T0 = 1_700_000_000_000
const PROVIDER_SESSION = {
  key: 'session_id' as const,
  id: 'ac1f6b90-2f77-4f0e-9c5e-1d2f6a4b8c31',
  transcriptPath: '/transcripts/ac1f6b90.jsonl'
}

/** A Store holding one workspace session, so the created terminal is a tab in the phone list. */
function sessionStore(): {
  store: ConstructorParameters<typeof OrcaRuntimeService>[0]
  saveTab: (edit: (tab: TerminalTab) => TerminalTab) => void
} {
  let session = getDefaultWorkspaceSession()
  const store = {
    getSettings: () => getDefaultSettings('/tmp'),
    getRepo: () => undefined,
    getRepos: () => [],
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    getWorkspaceSessionHostIds: () => ['local'],
    getWorkspaceSession: () => session,
    setWorkspaceSession: (next: WorkspaceSessionState) => {
      session = next
    }
  }
  // A window session save, which the holder reloads on its next read.
  const saveTab = (edit: (tab: TerminalTab) => TerminalTab): void => {
    const tabs = session.tabsByWorktree[WORKTREE_ID] ?? []
    session = { ...session, tabsByWorktree: { [WORKTREE_ID]: tabs.map(edit) } }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The layout holder reads only the session members this store defines.
  return { store: store as never, saveTab }
}

async function createRuntime(
  rows: AgentStatusIpcPayload[] = [],
  sessions = sessionStore()
): Promise<OrcaRuntimeService> {
  const runtime = new OrcaRuntimeService(sessions.store, undefined, {
    getAgentStatusSnapshot: () => rows
  })
  const internals = runtime as unknown as {
    resolveTerminalWorkspaceLaunchScope: (selector: string) => Promise<unknown>
  }
  vi.spyOn(internals, 'resolveTerminalWorkspaceLaunchScope').mockResolvedValue({
    id: WORKTREE_ID,
    path: '/repo/app',
    connectionId: null,
    repo: null,
    folderWorkspace: null
  })
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: PTY_ID }),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  await runtime.createTerminal(`id:${WORKTREE_ID}`, {
    tabId: TAB_ID,
    leafId: LEAF_ID,
    launchAgent: 'claude',
    title: 'Terminal'
  })
  return runtime
}

/** A working hook row, then a live pane title observed after it (phones get status from the hook store). */
async function createWorkingPane(paneTitle: string): Promise<OrcaRuntimeService> {
  const workingRow: AgentStatusIpcPayload = {
    paneKey: PANE_KEY,
    state: 'working',
    prompt: 'Configurar y entender los comprobantes',
    agentType: 'claude',
    connectionId: null,
    receivedAt: Date.now() - 1_000,
    stateStartedAt: Date.now() - 1_000,
    tabId: TAB_ID,
    worktreeId: WORKTREE_ID
  }
  const runtime = await createRuntime([workingRow])
  runtime.onPtyData(PTY_ID, `\x1b]0;${paneTitle}\x07`, Date.now())
  return runtime
}

async function projectAgentStatus(
  runtime: OrcaRuntimeService
): Promise<Record<string, unknown> | undefined> {
  const result = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
  const tab = result.tabs[0]
  return tab?.type === 'terminal'
    ? (tab.agentStatus as unknown as Record<string, unknown> | undefined)
    : undefined
}

describe('mobile session tabs: live-title evidence vs published agent status', () => {
  it('does not resurrect launch identity after the renderer clears it', async () => {
    const sessions = sessionStore()
    const runtime = await createRuntime([], sessions)
    expect((await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)).tabs[0]).toHaveProperty(
      'launchAgent',
      'claude'
    )
    sessions.saveTab(({ launchAgent: _launchAgent, ...tab }) => ({
      ...tab,
      title: '[Image #1] Inspect this'
    }))

    const result = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
    expect(result.tabs[0]).toEqual(expect.objectContaining({ type: 'terminal' }))
    expect(result.tabs[0]).not.toHaveProperty('launchAgent')
  })

  it('keeps a hook-reported working under a neutral live title', async () => {
    const runtime = await createWorkingPane('Terminal')

    expect(await projectAgentStatus(runtime)).toEqual(
      expect.objectContaining({
        state: 'working',
        prompt: 'Configurar y entender los comprobantes'
      })
    )
  })

  // #1437 preserved: a genuine shell prompt is proof the agent released the pane.
  it.each(['zsh', 'bash', 'pwsh'])(
    'clears a stale working to identity-only done under the shell title %s',
    async (shell) => {
      const runtime = await createWorkingPane(shell)

      const agentStatus = await projectAgentStatus(runtime)
      expect(agentStatus).toEqual(expect.objectContaining({ state: 'done', prompt: '' }))
      expect(agentStatus).toHaveProperty('agentType', 'claude')
    }
  )

  it('clears a stale working under a Claude management title', async () => {
    const runtime = await createWorkingPane('claude agents')

    expect(await projectAgentStatus(runtime)).toEqual(
      expect.objectContaining({ state: 'done', prompt: '' })
    )
  })
})

describe('mobile session tabs: identity-only fallback freshness', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('dates the identity-only done by its title evidence, not by output bytes', async () => {
    const resumeRow: AgentStatusIpcPayload = {
      paneKey: PANE_KEY,
      state: 'done',
      prompt: '',
      agentType: 'claude',
      connectionId: null,
      receivedAt: T0,
      stateStartedAt: T0,
      tabId: TAB_ID,
      worktreeId: WORKTREE_ID,
      providerSession: PROVIDER_SESSION,
      providerSessionOnly: true
    }
    const runtime = await createRuntime([resumeRow])
    // Title evidence lands once...
    runtime.onPtyData(PTY_ID, '\x1b]0;Terminal\x07', T0)
    const titleObservedAt = Date.now()

    // ...then the pane keeps streaming output with no new status evidence.
    vi.setSystemTime(T0 + 60_000)
    runtime.onPtyData(PTY_ID, 'building...\r\n', T0 + 60_000)

    const agentStatus = await projectAgentStatus(runtime)
    expect(agentStatus).toEqual(
      expect.objectContaining({
        state: 'done',
        updatedAt: titleObservedAt,
        stateStartedAt: titleObservedAt
      })
    )

    // Republishing after still more output must not refresh the frame.
    vi.setSystemTime(T0 + 120_000)
    runtime.onPtyData(PTY_ID, 'still building...\r\n', T0 + 120_000)
    expect(await projectAgentStatus(runtime)).toEqual(
      expect.objectContaining({ updatedAt: titleObservedAt })
    )
  })
})
