import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { translate } from '@/i18n/i18n'
import { track } from '@/lib/telemetry'
import { getRepoHostIdentity } from '@/store/slices/repo-host-identity'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { getHiddenImportableExternalWorktrees } from '../../../../shared/external-worktree-inbox'
import type { Repo } from '../../../../shared/repo-types'
import {
  importNewExternalWorktreeInboxPaths,
  type NewExternalWorktreesInboxActionState
} from './new-external-worktrees-inbox-actions'
import { resolveWorktreeVisibilityHostTargetForHost } from './worktree-visibility-host-target'
import {
  finishVisibilityMutation,
  getActiveVisibilityMutation,
  startVisibilityMutation,
  type ActiveVisibilityMutation
} from './worktree-visibility-mutation-fence'

export function useWorktreeVisibilityImport({
  repo,
  mutationScope,
  currentMutationScopeRef,
  updateTargetRepo,
  refreshTargetRepo,
  setActionState,
  setBusyPath,
  setIsToggling,
  setListState,
  telemetryEnabled
}: {
  repo: Repo | null
  mutationScope: string
  currentMutationScopeRef: MutableRefObject<string>
  updateTargetRepo: (id: string, updates: Parameters<AppState['updateRepo']>[1]) => Promise<boolean>
  refreshTargetRepo: (id: string, options?: { requireAuthoritative?: boolean }) => Promise<boolean>
  setActionState: Dispatch<SetStateAction<NewExternalWorktreesInboxActionState | null>>
  setBusyPath: Dispatch<SetStateAction<string | null>>
  setIsToggling: Dispatch<SetStateAction<boolean>>
  setListState: Dispatch<SetStateAction<'checking' | 'ready' | 'failed'>>
  telemetryEnabled: boolean
}): (paths: readonly string[]) => Promise<boolean> {
  return useCallback(
    async (paths: readonly string[]): Promise<boolean> => {
      if (!repo || getActiveVisibilityMutation(mutationScope)) {
        return false
      }
      const target = resolveWorktreeVisibilityHostTargetForHost(
        useAppStore.getState(),
        repo.id,
        getRepoExecutionHostId(repo)
      )
      const hiddenPaths = new Set(
        getHiddenImportableExternalWorktrees(target.detected).map((worktree) => worktree.path)
      )
      const selectedPaths = [...new Set(paths)].filter((path) => hiddenPaths.has(path))
      if (!target.repo || selectedPaths.length === 0) {
        return false
      }
      const mutation: ActiveVisibilityMutation =
        selectedPaths.length === 1 ? { kind: 'row', path: selectedPaths[0] } : { kind: 'toggle' }
      const targetMutationScope = getRepoHostIdentity(repo)
      startVisibilityMutation(targetMutationScope, mutation)
      if (mutation.kind === 'row') {
        setBusyPath(mutation.path)
      } else {
        setIsToggling(true)
      }
      try {
        const accepted = await importNewExternalWorktreeInboxPaths({
          projectId: repo.id,
          repo: target.repo,
          worktreePaths: selectedPaths,
          updateRepo: updateTargetRepo,
          fetchWorktrees: refreshTargetRepo,
          setInboxState: (_projectId, state) => {
            if (currentMutationScopeRef.current !== targetMutationScope) {
              return
            }
            setActionState(state)
            // Null action state proves an authoritative refetch succeeded, superseding the earlier failed scan.
            if (state === null) {
              setListState('ready')
            }
          }
        })
        if (accepted && telemetryEnabled) {
          track('workspace_discovery_action', {
            action: 'import_completed',
            surface: 'manage',
            workspace_count: Math.min(selectedPaths.length, 50)
          })
        }
        return accepted
      } catch {
        if (currentMutationScopeRef.current === targetMutationScope) {
          setActionState({
            pending: false,
            error: translate('workspaceDiscovery.addError', 'Could not add workspaces. Try again.')
          })
        }
        return false
      } finally {
        finishVisibilityMutation(targetMutationScope, mutation)
        if (currentMutationScopeRef.current === targetMutationScope) {
          setBusyPath(null)
          setIsToggling(false)
        }
      }
    },
    [
      mutationScope,
      refreshTargetRepo,
      repo,
      telemetryEnabled,
      updateTargetRepo,
      currentMutationScopeRef,
      setBusyPath,
      setActionState,
      setIsToggling,
      setListState
    ]
  )
}
