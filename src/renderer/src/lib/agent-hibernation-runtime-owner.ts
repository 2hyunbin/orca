import type { AppState } from '@/store/types'
import { resolveTerminalTeardownOwner } from '@/store/terminals/terminal-teardown-owner'
import { resolveRuntimeOwnerForWorktree } from './worktree-runtime-owner'

export type AgentHibernationRuntimeOwner =
  | { kind: 'runtime'; environmentId: string }
  | { kind: 'non-runtime' }
  // Why: hibernation must fail closed; no host can be asked for liveness or told to stop.
  | { kind: 'unresolved' }

export function resolveAgentHibernationRuntimeOwner(
  state: AppState,
  worktreeId: string
): AgentHibernationRuntimeOwner {
  const worktreeOwner = resolveRuntimeOwnerForWorktree(state, worktreeId)
  if (worktreeOwner.kind !== 'ambiguous') {
    return worktreeOwner
  }
  // Why: two hosts publish this worktree, so only each PTY's own `remote:<env>@@` id names its host.
  const ptyIds = (state.tabsByWorktree[worktreeId] ?? []).flatMap(
    (tab) => state.ptyIdsByTabId[tab.id] ?? []
  )
  const teardownOwner = resolveTerminalTeardownOwner(worktreeOwner, ptyIds)
  if (teardownOwner.kind === 'refused') {
    return { kind: 'unresolved' }
  }
  const environmentId = teardownOwner.runtimeEnvironmentId
  return environmentId ? { kind: 'runtime', environmentId } : { kind: 'non-runtime' }
}
