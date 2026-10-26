import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { Repo } from '../../../../../../shared/repo-types'
import { getRepoExecutionHostId } from '../../../../../../shared/execution-host'
import { getHiddenImportableExternalWorktrees } from '../../../../../../shared/external-worktree-inbox'
import { translate } from '@/i18n/i18n'
import { getRepoHostIdentity } from '@/store/slices/repo-host-identity'
import {
  keepImportedWorktreesHiddenCard,
  type ImportedWorktreeCardActionState
} from '../../imported-worktrees-card-actions'
import { buildImportedWorktreesCardCandidates } from '../../imported-worktrees-card-candidates'
import { importNewExternalWorktreeInboxPaths } from '../../new-external-worktrees-inbox-actions'
import { buildNewExternalWorktreesInboxCandidates } from '../../new-external-worktrees-inbox-candidates'
import { resolveWorktreeVisibilityHostTarget } from '../../worktree-visibility-host-target'
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
  const updateRepo = useAppStore((s) => s.updateRepo)
  const fetchWorktrees = useAppStore((s) => s.fetchWorktrees)
  const settings = useAppStore((s) => s.settings)
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData)
  const visibilityDefaultsByHost = useAppStore((s) => s.worktreeVisibilityDefaultsByHost)
  const [importedWorktreeCardActionState, setActionStates] = useState<
    Map<string, ImportedWorktreeCardActionState>
  >(new Map())
  const managedRepo =
    activeModal === 'worktree-visibility' &&
    modalData.inline === true &&
    typeof modalData.repoId === 'string'
      ? resolveWorktreeVisibilityHostTarget(
          {
            repos: [...args.repos],
            settings,
            detectedWorktreesByRepo: args.detectedWorktreesByRepo
          },
          modalData.repoId,
          modalData.hostId
        ).repo
      : undefined
  const managedScope = managedRepo ? getRepoHostIdentity(managedRepo) : null
  const managedRepoId = managedRepo?.id
  const managedHostId = managedRepo ? getRepoExecutionHostId(managedRepo) : undefined
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

  useEffect(() => {
    if (
      !managedRepoId ||
      !managedHostId ||
      !managedScope ||
      getActiveVisibilityMutation(managedScope)
    ) {
      return
    }
    let cancelled = false
    setActionState(managedScope, { pending: true, error: null })
    void fetchWorktrees(managedRepoId, {
      requireAuthoritative: true,
      executionHostId: managedHostId
    }).then((refreshed) => {
      if (!cancelled) {
        setActionState(
          managedScope,
          refreshed
            ? null
            : {
                pending: false,
                error: translate(
                  'workspaceDiscovery.scanError',
                  'Could not check workspaces. Reopen Manage workspaces to try again.'
                )
              }
        )
      }
    })
    return () => {
      cancelled = true
    }
  }, [managedScope, managedRepoId, managedHostId, fetchWorktrees, setActionState])

  const importedWorktreesByRepo = useMemo(
    () =>
      buildImportedWorktreesCardCandidates({
        repos: args.visibleReposForRows,
        detectedWorktreesByRepo: args.detectedWorktreesByRepo,
        filterRepoIds: args.filterRepoIds,
        settings,
        visibilityDefaultsByHost,
        managedRepo: managedRepo ?? undefined
      }),
    [
      args.visibleReposForRows,
      args.detectedWorktreesByRepo,
      args.filterRepoIds,
      settings,
      visibilityDefaultsByHost,
      managedRepo
    ]
  )
  const newExternalWorktreesInboxByRepo = useMemo(() => {
    const candidates = buildNewExternalWorktreesInboxCandidates({
      repos: args.visibleReposForRows,
      detectedWorktreesByRepo: args.detectedWorktreesByRepo,
      filterRepoIds: args.filterRepoIds,
      settings,
      visibilityDefaultsByHost
    })
    for (const repoId of importedWorktreesByRepo.keys()) {
      candidates.delete(repoId)
    }
    return candidates
  }, [
    args.visibleReposForRows,
    args.detectedWorktreesByRepo,
    args.filterRepoIds,
    settings,
    visibilityDefaultsByHost,
    importedWorktreesByRepo
  ])

  const commit = useCallback(
    async (repo: Repo, paths?: readonly string[]): Promise<boolean> => {
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
        if (!(await refreshTargetRepo(repo.id, { requireAuthoritative: true }))) {
          throw new Error('workspace scan failed')
        }
        const { repo: latestRepo, detected } = resolveWorktreeVisibilityHostTarget(
          useAppStore.getState(),
          repo.id,
          hostId
        )
        if (!latestRepo || detected?.authoritative !== true) {
          throw new Error('workspace scope unavailable')
        }
        if (paths) {
          const hiddenPaths = new Set(
            getHiddenImportableExternalWorktrees(detected).map((worktree) => worktree.path)
          )
          const selectedPaths = [...new Set(paths)].filter((path) => hiddenPaths.has(path))
          if (!selectedPaths.length) {
            throw new Error('selected workspaces unavailable')
          }
          return await importNewExternalWorktreeInboxPaths({
            projectId: repo.id,
            repo: latestRepo,
            worktreePaths: selectedPaths,
            updateRepo: updateTargetRepo,
            fetchWorktrees: refreshTargetRepo,
            setInboxState: (_id, state) => setActionState(scope, state)
          })
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

  const handleShowImportedWorktrees = useCallback(
    (repo: Repo, paths: readonly string[]) => commit(repo, paths),
    [commit]
  )
  const handleKeepImportedWorktreesHidden = useCallback((repo: Repo) => commit(repo), [commit])
  return {
    importedWorktreeCardActionState,
    importedWorktreesByRepo,
    newExternalWorktreesInboxByRepo,
    handleShowImportedWorktrees,
    handleKeepImportedWorktreesHidden
  }
}
