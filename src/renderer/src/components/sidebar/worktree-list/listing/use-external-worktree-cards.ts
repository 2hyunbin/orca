import { useCallback, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { Repo } from '../../../../../../shared/repo-types'
import { getRepoExecutionHostId } from '../../../../../../shared/execution-host'
import { getHiddenImportableExternalWorktrees } from '../../../../../../shared/external-worktree-inbox'
import { translate } from '@/i18n/i18n'
import { getRepoHostIdentity } from '@/store/slices/repo-host-identity'
import { selectDetectedWorktreesByRepo } from '@/store/workspace-record-selectors'
import {
  keepImportedWorktreesHiddenCard,
  type ImportedWorktreeCardActionState
} from '../../imported-worktrees-card-actions'
import { buildImportedWorktreesCardCandidates } from '../../imported-worktrees-card-candidates'
import { buildNewExternalWorktreesInboxCandidates } from '../../new-external-worktrees-inbox-candidates'
import { resolveWorktreeVisibilityHostTargetForHost } from '../../worktree-visibility-host-target'
import {
  getActiveVisibilityMutation,
  startVisibilityMutation,
  finishVisibilityMutation,
  type ActiveVisibilityMutation
} from '../../worktree-visibility-mutation-fence'

export function useSidebarExternalWorktreeCards(args: {
  repos: readonly Repo[]
  visibleReposForRows: readonly Repo[]
  detectedWorktreesByRepo: AppState['detectedWorktreesByRepo']
  filterRepoIds: readonly string[]
}) {
  const detectedWorktreesByRepo = selectDetectedWorktreesByRepo(args)
  const updateRepo = useAppStore((s) => s.updateRepo)
  const fetchWorktrees = useAppStore((s) => s.fetchWorktrees)
  const settings = useAppStore((s) => s.settings)
  const visibilityDefaultsByHost = useAppStore((s) => s.worktreeVisibilityDefaultsByHost)
  const [importedWorktreeCardActionState, setActionStates] = useState<
    Map<string, ImportedWorktreeCardActionState>
  >(new Map())
  const setActionState = useCallback(
    (scope: string, state: ImportedWorktreeCardActionState | null) => {
      setActionStates((current) => {
        const next = new Map(current)
        if (state) {
          next.set(scope, state)
        } else {
          next.delete(scope)
        }
        return next
      })
    },
    []
  )

  const importedWorktreesByRepo = useMemo(
    () =>
      buildImportedWorktreesCardCandidates({
        repos: args.visibleReposForRows,
        detectedWorktreesByRepo,
        filterRepoIds: args.filterRepoIds,
        settings,
        visibilityDefaultsByHost
      }),
    [
      args.visibleReposForRows,
      detectedWorktreesByRepo,
      args.filterRepoIds,
      settings,
      visibilityDefaultsByHost
    ]
  )
  const newExternalWorktreesInboxByRepo = useMemo(() => {
    const candidates = buildNewExternalWorktreesInboxCandidates({
      repos: args.visibleReposForRows,
      detectedWorktreesByRepo,
      filterRepoIds: args.filterRepoIds,
      settings,
      visibilityDefaultsByHost
    })
    // One hint per project owner: the first suggestion supersedes that owner's inbox, not a same-ID project on another host.
    for (const [repoId, imported] of importedWorktreesByRepo) {
      const inbox = candidates.get(repoId)
      if (inbox && getRepoHostIdentity(inbox.repo) === getRepoHostIdentity(imported.repo)) {
        candidates.delete(repoId)
      }
    }
    return candidates
  }, [
    args.visibleReposForRows,
    detectedWorktreesByRepo,
    args.filterRepoIds,
    settings,
    visibilityDefaultsByHost,
    importedWorktreesByRepo
  ])

  const handleKeepImportedWorktreesHidden = useCallback(
    async (repo: Repo): Promise<boolean> => {
      const scope = getRepoHostIdentity(repo)
      if (getActiveVisibilityMutation(scope)) {
        return false
      }
      const mutation: ActiveVisibilityMutation = { kind: 'toggle' }
      startVisibilityMutation(scope, mutation)
      setActionState(scope, { pending: true, error: null })
      const hostId = getRepoExecutionHostId(repo)
      const updateTargetRepo = (id: string, updates: Parameters<typeof updateRepo>[1]) =>
        updateRepo(id, updates, { hostId })
      const refreshTargetRepo = (id: string, options?: { requireAuthoritative?: boolean }) =>
        fetchWorktrees(id, { ...options, executionHostId: hostId })
      try {
        let target = resolveWorktreeVisibilityHostTargetForHost(
          useAppStore.getState(),
          repo.id,
          hostId
        )
        // Baseline seeding needs authoritative hidden paths; rescan only when the snapshot is stale.
        if (target.detected?.authoritative !== true) {
          if (!(await refreshTargetRepo(repo.id, { requireAuthoritative: true }))) {
            throw new Error('workspace scan failed')
          }
          target = resolveWorktreeVisibilityHostTargetForHost(
            useAppStore.getState(),
            repo.id,
            hostId
          )
        }
        const { repo: latestRepo, detected } = target
        if (!latestRepo || detected?.authoritative !== true) {
          throw new Error('workspace scope unavailable')
        }
        let accepted = false
        await keepImportedWorktreesHiddenCard({
          projectId: repo.id,
          updateRepo: updateTargetRepo,
          hiddenWorktreePaths: getHiddenImportableExternalWorktrees(detected).map(
            (worktree) => worktree.path
          ),
          existingBaselinePaths: latestRepo.externalWorktreeInboxBaselinePaths,
          setCardState: (_id, state) => {
            accepted = state === null
            setActionState(scope, state)
          }
        })
        return accepted
      } catch {
        setActionState(scope, {
          pending: false,
          error: translate(
            'workspaceDiscovery.updateError',
            'Could not save workspace visibility. Try again.'
          )
        })
        return false
      } finally {
        finishVisibilityMutation(scope, mutation)
      }
    },
    [fetchWorktrees, setActionState, updateRepo]
  )

  return {
    importedWorktreeCardActionState,
    importedWorktreesByRepo,
    newExternalWorktreesInboxByRepo,
    handleKeepImportedWorktreesHidden
  }
}
