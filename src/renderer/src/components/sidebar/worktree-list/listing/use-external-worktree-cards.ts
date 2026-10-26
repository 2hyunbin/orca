import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { Repo } from '../../../../../../shared/repo-types'
import type {
  ImportedWorktreesCardCandidate,
  NewExternalWorktreesInboxCandidate
} from '../../../../../../shared/sidebar-list/row-types'
import { getRepoExecutionHostId } from '../../../../../../shared/execution-host'
import { getHiddenImportableExternalWorktrees } from '../../../../../../shared/external-worktree-inbox'
import { translate } from '@/i18n/i18n'
import { trackWithResult } from '@/lib/telemetry'
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

const NO_IMPORTED_WORKTREES: ReadonlyMap<string, ImportedWorktreesCardCandidate> = new Map()
const NO_NEW_EXTERNAL_WORKTREES: ReadonlyMap<string, NewExternalWorktreesInboxCandidate> = new Map()
const NO_DISCOVERY_PLACEHOLDERS: ReadonlySet<string> = new Set()

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
  const discoveryCohort = settings?.telemetry?.workspaceDiscoveryCohort
  const telemetryEnabled =
    settings?.telemetry?.optedIn === true &&
    (discoveryCohort === 'control' || discoveryCohort === 'treatment')
  const hideSuggestions = !settings || discoveryCohort === 'control'
  const trackedEligibility = useRef(false)
  const eligibilityPending = useRef<Promise<boolean | void> | null>(null)
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
    for (const repoId of importedWorktreesByRepo.keys()) {
      candidates.delete(repoId)
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

  useEffect(() => {
    if (!telemetryEnabled || trackedEligibility.current) {
      return
    }
    if (newExternalWorktreesInboxByRepo.size === 0 && !importedWorktreesByRepo.size) {
      return
    }
    let cancelled = false
    void (async () => {
      await eligibilityPending.current
      if (cancelled || trackedEligibility.current) {
        return
      }
      const observation = trackWithResult('workspace_discovery_eligible', {})
      eligibilityPending.current = observation
      const accepted = await observation
      if (accepted !== false) {
        trackedEligibility.current = true
      }
      eligibilityPending.current = null
    })()
    return () => {
      cancelled = true
    }
  }, [telemetryEnabled, importedWorktreesByRepo, newExternalWorktreesInboxByRepo])

  const visibleImportedWorktreesByRepo = hideSuggestions
    ? NO_IMPORTED_WORKTREES
    : importedWorktreesByRepo
  const visibleNewExternalWorktreesInboxByRepo = useMemo(
    () => (hideSuggestions ? NO_NEW_EXTERNAL_WORKTREES : newExternalWorktreesInboxByRepo),
    [hideSuggestions, newExternalWorktreesInboxByRepo]
  )
  const discoveryPlaceholderRepoIds = useMemo(
    () =>
      hideSuggestions &&
      (importedWorktreesByRepo.size > 0 || newExternalWorktreesInboxByRepo.size > 0)
        ? new Set([...importedWorktreesByRepo.keys(), ...newExternalWorktreesInboxByRepo.keys()])
        : NO_DISCOVERY_PLACEHOLDERS,
    [hideSuggestions, importedWorktreesByRepo, newExternalWorktreesInboxByRepo]
  )

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
        if (!(await refreshTargetRepo(repo.id, { requireAuthoritative: true }))) {
          throw new Error('workspace scan failed')
        }
        const { repo: latestRepo, detected } = resolveWorktreeVisibilityHostTargetForHost(
          useAppStore.getState(),
          repo.id,
          hostId
        )
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
    discoveryPlaceholderRepoIds,
    importedWorktreesByRepo: visibleImportedWorktreesByRepo,
    newExternalWorktreesInboxByRepo: visibleNewExternalWorktreesInboxByRepo,
    handleKeepImportedWorktreesHidden
  }
}
