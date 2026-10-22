import { vi } from 'vitest'
import type { AgentLaunchResult } from '../../shared/agent-launch-intent'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import type { HostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'
import type { AgentPaneWorkspace } from '../agent-hooks/agent-transition-detector'
import type { AgentLaunchPublishedSurface } from '../agent-launch/agent-launch-execution'
import type { ExternalConversationLinkStore } from './external-conversation-links'
import type { ConversationLauncher } from './external-conversation-start'

export const WORKTREE = 'repo-1::/work/a'
export const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'
export const LOCAL_REPO: Repo = {
  id: 'repo-1',
  path: '/work',
  displayName: 'repo',
  badgeColor: '#000000',
  addedAt: 0
}

type LinkRow = { externalConversations?: unknown; hostId?: ExecutionHostId }

export function fakeLinkStore(repos: Repo[] = [LOCAL_REPO]) {
  const meta: Record<string, LinkRow> = {}
  const folders: (LinkRow & { id: string })[] = []
  const writes: HostWorktreeTarget[] = []
  const store = {
    getRepos: () => repos,
    getAllWorktreeMeta: () => meta,
    getWorktreeMeta: (id: string) => meta[id],
    getWorktreeMetaForHost: (id: string, hostId: ExecutionHostId) =>
      meta[id]?.hostId === hostId ? meta[id] : undefined,
    setWorktreeMeta: (target: HostWorktreeTarget, updates: { externalConversations: unknown }) => {
      writes.push(target)
      meta[target.id] = { ...meta[target.id], ...updates, hostId: target.hostId }
    },
    getFolderWorkspace: (id: string) => folders.find((folder) => folder.id === id),
    getFolderWorkspaces: () => folders,
    updateFolderWorkspace: (id: string, updates: { externalConversations: unknown }) => {
      const folder = folders.find((candidate) => candidate.id === id)
      if (folder) {
        folder.externalConversations = updates.externalConversations
      }
    }
  } satisfies ExternalConversationLinkStore
  return { store, meta, folders, writes }
}

export function launchResult(
  prompt: 'handed-to-terminal' | 'not-delivered' | 'unconfirmed' | null,
  worktreeId = WORKTREE,
  paneKey = PANE
): AgentLaunchResult {
  return {
    outcome: { kind: 'terminal', handle: 'term-1', paneKey },
    worktreeId,
    receipt: {
      mode: 'terminal',
      preferred: 'terminal',
      reason: 'user_default',
      detail: 'terminal'
    },
    ...(prompt ? { prompt: { delivery: 'submit', outcome: prompt } } : {})
  }
}

/** Publishes, then settles as `settle` says; `workspace` is the pane's host-qualified workspace. */
export function fakeLauncher(
  settle: () => Promise<AgentLaunchResult>,
  workspace: AgentPaneWorkspace = { worktreeId: WORKTREE, sshHostId: null },
  publish = true
) {
  const launch = vi.fn(
    async (
      _input: unknown,
      onSurfacePublished: (surface: AgentLaunchPublishedSurface) => void
    ): Promise<AgentLaunchResult> => {
      if (publish) {
        onSurfacePublished(launchResult(null, workspace.worktreeId))
      }
      return settle()
    }
  )
  const launcher: ConversationLauncher = { launch, paneWorkspace: async () => workspace }
  return { launcher, launch }
}
