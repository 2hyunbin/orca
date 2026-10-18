// Runs on plain Node, as orcad does: a host with no window raises and clears its own unread flags.
import '../rpc/unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../shared/runtime-session-contracts'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import type { Worktree } from '../../../shared/worktree/types'
import { AgentHookServer } from '../../agent-hooks/server'
import { OrcaRuntimeService } from '../orca-runtime'
import type { ResolvedWorktree } from '../runtime-worktree-path-identity'
import type { RuntimeStore } from '../runtime-store-contract'
import { RpcDispatcher } from '../rpc/dispatcher'
import type { RpcDispatchStreamingOptions } from '../rpc/dispatcher-stream-options'
import { SESSION_TAB_METHODS } from '../rpc/methods/session-tabs'
import { SIDEBAR_INPUT_METHODS } from '../rpc/methods/sidebar-inputs'

vi.mock('../../../shared/sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))

const WT = 'repo-1::/tmp/worktree-a'
const SSH_WT = 'repo-ssh::/home/me/worktree-b'
const FOLDER_ID = '11111111-1111-4111-8111-111111111111'
const FOLDER = folderWorkspaceKey(FOLDER_ID)
const LEAF = '22222222-2222-4222-8222-222222222222'
const PANE = `tab-1:${LEAF}`
const PHONE: RpcDispatchStreamingOptions = { clientKind: 'mobile', connectionId: 'phone-1' }

type Flag = { lastActivityAt: number; isUnread: boolean }

function resolved(id: string, repoId: string, hostId?: Worktree['hostId']): ResolvedWorktree {
  const path = id.slice(id.indexOf('::') + 2)
  return {
    id,
    repoId,
    path,
    ...(hostId ? { hostId } : {}),
    branch: 'feature',
    head: '',
    isBare: false,
    isMainWorktree: false,
    displayName: 'Feature',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedItems: [],
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    parentWorktreeId: null,
    childWorktreeIds: [],
    lineage: null,
    git: { path, head: '', branch: 'feature', isBare: false, isMainWorktree: false }
  }
}

class HeadlessHost extends OrcaRuntimeService {
  selected = resolved(WT, 'repo-1')
  protected override async resolveWorktreeSelector(): Promise<ResolvedWorktree> {
    return this.selected
  }
}

function createHeadlessHost() {
  const meta: Record<string, Flag> = { [WT]: { lastActivityAt: 0, isUnread: false } }
  const sshMeta: Record<string, Flag> = { [SSH_WT]: { lastActivityAt: 0, isUnread: false } }
  const folders: Record<string, Flag> = { [FOLDER_ID]: { lastActivityAt: 0, isUnread: false } }
  const repos = [
    { id: 'repo-1', connectionId: null },
    { id: 'repo-ssh', connectionId: 'build-box' }
  ]
  const store = {
    getRepos: () => repos,
    getRepo: (id: string) => repos.find((repo) => repo.id === id),
    getSettings: () => ({}),
    getWorktreeMeta: (id: string) => meta[id],
    getAllWorktreeMeta: () => meta,
    setWorktreeMeta: (id: string, updates: Partial<Flag>) => Object.assign(meta[id], updates),
    getWorktreeMetaForHost: (id: string, hostId: string) =>
      hostId === 'ssh:build-box' ? sshMeta[id] : undefined,
    setWorktreeMetaForHost: (id: string, _hostId: string, updates: Partial<Flag>) =>
      Object.assign(sshMeta[id], updates),
    getFolderWorkspace: (id: string) => folders[id],
    updateFolderWorkspace: (id: string, updates: Partial<Flag>) =>
      Object.assign(folders[id], updates)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the unread path reads only these members.
  const runtime = new HeadlessHost(store as unknown as RuntimeStore)
  runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, {
    tabs: [{ tabId: 'tab-1', worktreeId: WT, title: 'Agent', activeLeafId: LEAF, layout: null }],
    leaves: [
      {
        tabId: 'tab-1',
        worktreeId: WT,
        leafId: LEAF,
        paneRuntimeId: 1,
        ptyId: 'pty-1',
        paneTitle: null
      }
    ]
  })
  const server = new AgentHookServer()
  runtime.sidebarFacts?.attachSidebarAgentStatusStore(server)
  const dispatcher = new RpcDispatcher({
    runtime,
    methods: [...SIDEBAR_INPUT_METHODS, ...SESSION_TAB_METHODS]
  })
  let requestId = 0
  const finishTurn = (worktreeId = WT, connectionId?: string): void => {
    for (const state of ['working', 'done'] as const) {
      server.ingestTerminalStatus({
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId,
        ...(connectionId ? { connectionId } : {}),
        payload: { state, prompt: 'task', agentType: 'claude' }
      })
    }
  }
  return {
    runtime,
    meta,
    sshMeta,
    folders,
    finishTurn,
    // The phone's open: worktree.activate with navigation kept on the caller.
    openOnPhone: (worktree: ResolvedWorktree) => {
      runtime.selected = worktree
      return runtime.activateManagedWorktree(`id:${worktree.id}`, {
        clientKind: 'mobile',
        navigation: 'caller'
      })
    },
    holdSessionOnPhone: (worktreeId: string) =>
      dispatcher.dispatchStreaming(
        {
          id: `sub-${++requestId}`,
          authToken: 'tok',
          method: 'session.tabs.subscribe',
          params: { worktree: `id:${worktreeId}` }
        },
        () => {},
        PHONE
      ),
    reportView: (params: unknown, connectionId: string) =>
      dispatcher.dispatch(
        { id: `view-${++requestId}`, authToken: 'tok', method: 'sidebarInputs.reportView', params },
        { clientKind: 'runtime', connectionId }
      )
  }
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('workspace unread flag on a headless host', () => {
  it('flags a finish no one sees, clears it when the phone opens it, and spares an open session', async () => {
    const host = createHeadlessHost()
    host.finishTurn()
    expect(host.meta[WT].isUnread).toBe(true)

    await host.openOnPhone(resolved(WT, 'repo-1'))
    expect(host.meta[WT].isUnread).toBe(false)

    await host.holdSessionOnPhone(WT)
    host.finishTurn()
    expect(host.meta[WT].isUnread).toBe(false)

    // Leaving the session (its stream closes with the connection) makes the next finish news.
    host.runtime.cleanupSubscriptionsForConnection('phone-1')
    host.finishTurn()
    expect(host.meta[WT].isUnread).toBe(true)
  })

  it('clears a folder workspace and an SSH worktree on their own records when the phone opens them', async () => {
    const host = createHeadlessHost()
    host.folders[FOLDER_ID].isUnread = true
    host.sshMeta[SSH_WT].isUnread = true
    const folder = { ...resolved(FOLDER, 'folder-workspace:group-1'), path: '/tmp/folder' }
    await host.openOnPhone(folder).catch(() => null)
    expect(host.folders[FOLDER_ID].isUnread).toBe(false)

    await host.openOnPhone(resolved(SSH_WT, 'repo-ssh', 'ssh:build-box'))
    expect(host.sshMeta[SSH_WT].isUnread).toBe(false)
    // The SSH finish raises the SSH host's record, not a local one of the same id.
    host.finishTurn(SSH_WT, 'build-box')
    expect(host.sshMeta[SSH_WT].isUnread).toBe(true)
  })

  it('spares the tab a client window shows while its user is present', async () => {
    vi.useFakeTimers({ now: 10_000, toFake: ['Date'] })
    try {
      const host = createHeadlessHost()
      const view = { workspaceIds: [WT], tabIds: ['tab-1'], presentForMs: 60_000 }
      expect(await host.reportView(view, 'desktop-1')).toMatchObject({ ok: true })
      host.finishTurn()
      expect(host.meta[WT].isUnread).toBe(false)

      // Another tab on screen is not this pane's.
      await host.reportView({ ...view, tabIds: ['tab-2'] }, 'desktop-1')
      host.finishTurn()
      expect(host.meta[WT].isUnread).toBe(true)

      host.meta[WT].isUnread = false
      await host.reportView(view, 'desktop-1')
      vi.setSystemTime(10_000 + 60_000)
      host.finishTurn()
      expect(host.meta[WT].isUnread).toBe(true)

      // A client that disconnects stops counting.
      host.meta[WT].isUnread = false
      await host.reportView({ ...view, presentForMs: null }, 'desktop-1')
      host.runtime.cleanupSubscriptionsForConnection('desktop-1')
      host.finishTurn()
      expect(host.meta[WT].isUnread).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
