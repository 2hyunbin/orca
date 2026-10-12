import { afterEach, describe, expect, it } from 'vitest'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { OrcaRuntimeService } from './orca-runtime'
import { getDefaultSettings, getDefaultWorkspaceSession } from '../../shared/constants'

afterEach(() => setStructuredAgentSessionHost(null))

const REPO = { id: 'repo-1', path: '/repo', displayName: 'repo', badgeColor: '#000', addedAt: 0 }
const LINKED = 'repo-1::/repo-linked'

/** A local repo whose linked worktree has no saved metadata and no saved tabs. */
function runtimeWithUnlistedLinkedWorktree(): OrcaRuntimeService {
  let session = getDefaultWorkspaceSession()
  const store = {
    getSettings: () => getDefaultSettings('/tmp'),
    getRepo: (id: string) => (id === REPO.id ? REPO : undefined),
    getRepos: () => [REPO],
    getAllWorktreeMeta: () => ({}),
    getAllWorktreeMetaForHost: () => ({}),
    getWorktreeMeta: () => undefined,
    getWorkspaceSessionHostIds: () => ['local'],
    getWorkspaceSession: () => session,
    setWorkspaceSession: (next: typeof session) => {
      session = next
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The runtime reads only the store members defined here on this path.
  const runtime = new OrcaRuntimeService(store as never)
  const internal = runtime as unknown as {
    hasPersistedStructuredAgentSessionStore(): boolean
    refreshMobileSessionPtyRecords(): Promise<Set<string> | null>
    ensureStructuredAgentSessionHost(): Promise<void>
  }
  internal.hasPersistedStructuredAgentSessionStore = () => true
  internal.refreshMobileSessionPtyRecords = async () => new Set()
  internal.ensureStructuredAgentSessionHost = async () => undefined
  return runtime
}

function setHostWithChats(chats: { sessionId: string; workspaceId: string }[]): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Restore reads only these host members.
  setStructuredAgentSessionHost({
    reconcileRestartLeases: async () => undefined,
    restoreReadableSessions: async () => undefined,
    listSessionTabs: () => chats.map((chat) => ({ ...chat, agent: 'claude' }))
  } as never)
}

async function chatRows(runtime: OrcaRuntimeService): Promise<string[]> {
  const listed = await runtime.listAllMobileSessionTabs()
  return (listed.find((row) => row.worktree === LINKED)?.tabs ?? []).map((tab) => tab.id)
}

describe('structured chat restore for a worktree only a scan lists', () => {
  it('opens the restored chat once the scan adds its worktree to the catalog', async () => {
    const runtime = runtimeWithUnlistedLinkedWorktree()
    setHostWithChats([{ sessionId: 'agent-session:chat-1', workspaceId: LINKED }])

    await runtime.restoreStructuredAgentSessionTabs()
    expect(await chatRows(runtime)).toEqual([])

    runtime.addCatalogWorktrees([{ id: LINKED, repoId: REPO.id }])
    expect(await chatRows(runtime)).toEqual(['agent-session:chat-1'])
  })

  it('keeps a chat closed while its worktree was unlisted closed', async () => {
    const runtime = runtimeWithUnlistedLinkedWorktree()
    setHostWithChats([{ sessionId: 'chat-1', workspaceId: LINKED }])
    await runtime.restoreStructuredAgentSessionTabs()

    setHostWithChats([])
    runtime.addCatalogWorktrees([{ id: LINKED, repoId: REPO.id }])
    expect(await chatRows(runtime)).toEqual([])
  })
})
