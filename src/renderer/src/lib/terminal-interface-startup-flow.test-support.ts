import type { TerminalProcessInspection } from '../../../shared/terminal-process-inspection'
import { expect, it, vi } from 'vitest'
import { TerminalInterfaceAuthority } from '../../../main/agent-hooks/server/terminal-interface-authority'
import { projectRuntimeMobileSessionTabs } from '../../../main/runtime/runtime-mobile-session-projection'
import type { RuntimeMobileSessionProjectionHost } from '../../../main/runtime/runtime-mobile-session-projection-contract'
import type { RuntimePtyWorktreeRecord } from '../../../main/runtime/runtime-terminal-state-records'
import type { TerminalState } from '../store/terminals/terminal-state'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { buildMobileTerminalSurfaceTabs } from '../runtime/sync-runtime-graph/mobile-session-terminal-tabs'
import type { MobileSessionWorktreeInputs } from '../runtime/sync-runtime-graph/types'
import { nativeChatShellForeground } from '../components/native-chat/terminal-interface-presentation'

/** Connect a real startup producer's output to the renderer and host mobile projections. */
export async function proveTerminalStartupInterfaceFlow(
  startup: TerminalState['pendingStartupByTabId'][string],
  draft: string | undefined,
  worktreeId: string
): Promise<void> {
  expect(startup.command).toBeTruthy()
  expect(startup.launchAgent).toBeTruthy()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
  const leafId = '11111111-1111-4111-8111-111111111111'
  const paneKey = `tab:${leafId}`
  const binding = {
    ptyId: 'startup-pty',
    incarnationId: 'startup-birth',
    terminalHandle: 'startup-handle',
    paneKey,
    worktreeId
  }
  let bound = false
  const authority = new TerminalInterfaceAuthority()
  const shell = {
    foregroundProcess: 'bash',
    hasChildProcesses: false,
    terminalInterface: { shellForeground: true, children: 'no-children' as const, capturedAgeMs: 0 }
  }
  let inspection: TerminalProcessInspection = shell
  const stop = authority.install({
    inventory: () =>
      bound
        ? [
            {
              binding,
              generation: 1,
              launchToken: startup.launchToken ?? null,
              local: true,
              blocked: false
            }
          ]
        : [],
    inspect: async () => inspection,
    changed: () => {}
  })
  authority.attachHookBindings(() => (bound ? binding : null))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the real projection only reads identity, connection, launch and title metadata from this inert PTY fixture.
  const pty = {
    ...binding,
    connected: true,
    connectionId: null,
    foregroundAgent: null,
    launchAgent: startup.launchAgent
  } as unknown as RuntimePtyWorktreeRecord
  const host: RuntimeMobileSessionProjectionHost = {
    tabs: new Map(),
    leaves: new Map(),
    ptysById: new Map(),
    getLiveBrowserTabs: () => new Map(),
    getProviderSessionRows: () => [],
    getProviderSessionSnapshot: () => [],
    getStatusSnapshot: () => [],
    getLeafKey: () => paneKey,
    findPty: () => (bound ? pty : null),
    getRetainedStatus: () => null,
    getTrackedTitle: () => null,
    getTitleDisplayClear: () => null,
    issuePtyHandle: () => binding.terminalHandle,
    recordPty: () => pty,
    buildPtyStatus: () => ({}),
    sanitizeGroups: () => [],
    pruneGroupLayout: () => null,
    collectTabIds: () => new Set(),
    readTerminalInterface: (id, incarnation) => authority.read(id, incarnation)
  }
  const terminal: TerminalTab = {
    id: 'tab',
    ptyId: null,
    worktreeId,
    title: 'Agent',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    launchAgent: startup.launchAgent
  }
  const inputs: MobileSessionWorktreeInputs = {
    worktreeId,
    worktreeInstanceId: undefined,
    terminalTabs: [terminal],
    browserWorkspaces: [],
    unifiedTabs: [],
    groups: [],
    tabBarOrder: [],
    activeGroupId: null,
    tabGroupLayout: undefined,
    openFilesById: undefined,
    openFileIds: [],
    terminalLayoutByTabId: new Map([
      ['tab', { root: { type: 'leaf', leafId }, activeLeafId: leafId, expandedLeafId: null }]
    ]),
    paneTitlesByTabId: new Map(),
    launchDraftByPaneKey: new Map(
      draft && startup.launchAgent
        ? [[paneKey, { tabId: 'tab', agent: startup.launchAgent, text: draft, createdAt: 1 }]]
        : []
    ),
    agentStatusByPaneKey: new Map(),
    editorDraftVersionByFileId: new Map(),
    pagesByBrowserWorkspaceId: new Map(),
    certificateFailureByBrowserPageId: new Map(),
    activeEditorFileId: null,
    activeEditorTabType: null,
    activeTerminalTabId: 'tab',
    activeBrowserWorkspaceId: null,
    generatedTitlesEnabled: false,
    terminalTheme: undefined,
    mountedSurfaceCaptureByTabId: new Map()
  }
  const project = () => {
    terminal.ptyId = bound ? binding.ptyId : null
    const result = projectRuntimeMobileSessionTabs(
      {
        worktree: worktreeId,
        publicationEpoch: 'startup',
        snapshotVersion: 1,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: 'terminal',
        tabs: buildMobileTerminalSurfaceTabs(inputs, terminal)
      },
      host
    ).tabs[0]
    if (result?.type !== 'terminal') {
      throw new Error('expected projected startup terminal')
    }
    expect(result.launchDraft).toBe(draft)
    expect(result.launchAgent).toBe(startup.launchAgent)
    return result
  }
  try {
    expect(project()).toMatchObject({ status: 'pending-handle', terminal: null })
    bound = true
    host.ptysById = new Map([[binding.ptyId, pty]])
    await vi.advanceTimersByTimeAsync(3000)
    expect(project()).toMatchObject({
      status: 'ready',
      terminalInterface: { state: 'shell', basis: 'cold' }
    })
    // This raw renderer startup has no universal host registry. A new binding is cold.
    authority.captureHook(
      paneKey,
      binding.terminalHandle
    )({
      token: 'original',
      launchToken: startup.launchToken,
      current: () => true,
      mayRetire: async () => false,
      retire: () => {}
    })
    inspection = {
      ...shell,
      hasChildProcesses: true,
      terminalInterface: {
        ...shell.terminalInterface,
        shellForeground: false,
        children: 'children'
      }
    }
    expect(project()).toMatchObject({ terminalInterface: { state: 'agent', basis: 'hook' } })
    await vi.advanceTimersByTimeAsync(1000)
    inspection = shell
    await vi.advanceTimersByTimeAsync(3000)
    const released = project()
    expect(released).toMatchObject({ terminalInterface: { state: 'shell', basis: 'hook' } })
    expect(
      nativeChatShellForeground(
        {
          terminalInterfaceByPtyId: {
            [binding.ptyId]: { observation: released.terminalInterface!, environmentId: null }
          },
          terminalLayoutsByTabId: {
            tab: {
              root: { type: 'leaf', leafId },
              activeLeafId: leafId,
              expandedLeafId: null,
              ptyIdsByLeafId: { [leafId]: binding.ptyId }
            }
          }
        },
        paneKey
      )
    ).toBe(true)
  } finally {
    stop()
    vi.useRealTimers()
  }
}

export function registerTerminalStartupProducerFlow(
  produce: (prompt: string | undefined) => Promise<{
    startup: TerminalState['pendingStartupByTabId'][string]
    draft: string | undefined
    worktreeId: string
  }>
): void {
  it.each([undefined, 'Keep this editable'])(
    'projects real new-tab startup through pending handle, cold binding and actual release (draft=%s)',
    async (prompt) => {
      const { startup, draft, worktreeId } = await produce(prompt)
      expect(draft).toBe(prompt)
      await proveTerminalStartupInterfaceFlow(startup, draft, worktreeId)
    }
  )
}
