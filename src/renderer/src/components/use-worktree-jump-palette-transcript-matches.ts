import { useCallback, useMemo, useState } from 'react'
import { resolveWorktreeFilterHostId } from '@/components/cmd-j/palette-filter-options'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { SESSION_SEARCH_LIMIT_MAX } from '../../../shared/ai-vault-search-limit'
import { resolveAiVaultSearchSettings } from '../../../shared/ai-vault-search-settings'
import {
  aiVaultSearchNeedsLocalConsent,
  useAiVaultSearch
} from './right-sidebar/use-ai-vault-search'
import {
  fitPaletteTranscriptMatches,
  resolvePaletteTranscriptEligibleTabs,
  resolvePaletteTranscriptMatches,
  type PaletteTranscriptMatch
} from './worktree-jump-palette-transcript-matches'
import type { PaletteTranscriptSnippet } from './worktree-jump-palette-model'
import type { WorktreeJumpPaletteLocalState } from './use-worktree-jump-palette-local-state'
import type { WorktreeJumpPaletteStoreState } from './use-worktree-jump-palette-store-state'
import type { AiVaultSearchHit } from '../../../shared/ai-vault-search-types'
import type { WorktreeJumpPaletteFilter } from './use-worktree-jump-palette-filter'
import {
  paletteTranscriptEligibility,
  paletteTranscriptPaneState
} from './cmd-j/palette-transcript-eligibility'
import { eligibleSessionsKey } from '../../../shared/ai-vault-search-eligible-sessions'
import {
  classifyPaletteTranscriptProof,
  preparePaletteTranscriptProofQuery
} from './cmd-j/palette-transcript-proof'

const TRANSCRIPT_MATCH_DEBOUNCE_MS = 120
const NO_HITS: readonly AiVaultSearchHit[] = []
const NO_MATCHES: readonly PaletteTranscriptMatch[] = []

type TranscriptMatchesInput = Pick<
  WorktreeJumpPaletteStoreState,
  | 'settings'
  | 'visible'
  | 'agentStatusByPaneKey'
  | 'retainedAgentsByPaneKey'
  | 'sleepingAgentSessionsByPaneKey'
  | 'tabsByWorktree'
  | 'terminalLayoutsByTabId'
  | 'workspaces'
  | 'unifiedTabsByWorktree'
> &
  Pick<WorktreeJumpPaletteLocalState, 'deferredQuery' | 'query' | 'filter'> &
  Pick<WorktreeJumpPaletteFilter, 'filterModel' | 'filterPredicate'>

/** This desktop's evidence, invalidated on raw input before deferred work commits. */
export function useWorktreeJumpPaletteTranscriptMatches({
  settings,
  visible,
  agentStatusByPaneKey,
  retainedAgentsByPaneKey,
  sleepingAgentSessionsByPaneKey,
  tabsByWorktree,
  terminalLayoutsByTabId,
  workspaces,
  unifiedTabsByWorktree,
  filterModel,
  filterPredicate,
  deferredQuery,
  query,
  filter
}: TranscriptMatchesInput) {
  const policy = useMemo(() => resolveAiVaultSearchSettings(settings), [settings])
  const transcriptGenerationKey = JSON.stringify([query, filter, policy, visible])
  const transcriptSearchEnabled =
    visible &&
    query.trim().length > 0 &&
    !aiVaultSearchNeedsLocalConsent(LOCAL_EXECUTION_HOST_ID, policy.enabled)
  const paneState = useMemo(() => {
    const localWorkspaces = workspaces.filter(
      (workspace) =>
        !workspace.runtimeOwnerEnvironmentId &&
        (!filterPredicate || filterPredicate.matchesWorktree(workspace)) &&
        resolveWorktreeFilterHostId(workspace, filterModel.repoById, LOCAL_EXECUTION_HOST_ID) ===
          LOCAL_EXECUTION_HOST_ID
    )
    return paletteTranscriptPaneState(
      {
        agentStatusByPaneKey,
        retainedAgentsByPaneKey,
        sleepingAgentSessionsByPaneKey,
        tabsByWorktree,
        terminalLayoutsByTabId
      },
      localWorkspaces,
      unifiedTabsByWorktree
    )
  }, [
    agentStatusByPaneKey,
    retainedAgentsByPaneKey,
    sleepingAgentSessionsByPaneKey,
    tabsByWorktree,
    terminalLayoutsByTabId,
    workspaces,
    unifiedTabsByWorktree,
    filterModel,
    filterPredicate
  ])
  const eligibleSessions = useMemo(() => paletteTranscriptEligibility(paneState), [paneState])
  const eligibilityKey =
    eligibleSessions === null ? 'invalid' : eligibleSessionsKey(eligibleSessions)
  const request = useMemo(
    () =>
      transcriptSearchEnabled &&
      deferredQuery === query &&
      eligibleSessions &&
      (eligibleSessions.providers.length > 0 || eligibleSessions.prompts.length > 0)
        ? { query: query.trim(), limit: SESSION_SEARCH_LIMIT_MAX, eligibleSessions }
        : null,
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- status timestamps do not change search eligibility.
    [transcriptSearchEnabled, deferredQuery, query, eligibilityKey]
  )
  const { hits, response, loading } = useAiVaultSearch(
    request,
    LOCAL_EXECUTION_HOST_ID,
    transcriptGenerationKey,
    TRANSCRIPT_MATCH_DEBOUNCE_MS
  )
  // Older hosts may silently drop an optional request field; keep their title results only.
  const acknowledgedHits =
    request && response?.kind === 'results' && response.eligibleSessionsApplied && hits.length
      ? hits
      : NO_HITS
  const [settled, setSettled] = useState({ key: transcriptGenerationKey, hits: NO_HITS })
  if (settled.key !== transcriptGenerationKey || (!loading && settled.hits !== acknowledgedHits)) {
    setSettled({ key: transcriptGenerationKey, hits: acknowledgedHits })
  }
  // Eligibility refreshes keep surviving destinations visible through the debounce.
  const stableHits =
    loading && settled.key === transcriptGenerationKey ? settled.hits : acknowledgedHits
  const proofWindows = useMemo(() => {
    const requirements = preparePaletteTranscriptProofQuery(query)
    return new Map(
      stableHits
        .slice(0, SESSION_SEARCH_LIMIT_MAX)
        .map((hit) => [
          hit,
          classifyPaletteTranscriptProof(hit.evidence?.originalExcerpt?.text ?? '', requirements)
        ])
    )
  }, [stableHits, query])
  const candidates = useMemo(
    () => resolvePaletteTranscriptMatches(stableHits, paneState, query, proofWindows),
    [stableHits, paneState, query, proofWindows]
  )
  const transcriptEligibleTabs = useMemo(
    () =>
      transcriptSearchEnabled ? resolvePaletteTranscriptEligibleTabs(paneState) : new Set<string>(),
    [paneState, transcriptSearchEnabled]
  )
  const [measured, setMeasured] = useState<{
    proofWindows: typeof proofWindows
    fits: ReadonlyMap<number, PaletteTranscriptSnippet>
    displayKey: string
  } | null>(null)
  const onFits = useCallback(
    (fits: ReadonlyMap<number, PaletteTranscriptSnippet>, displayKey: string) => {
      setMeasured({ proofWindows, fits, displayKey })
    },
    [proofWindows]
  )
  const transcriptMatches = useMemo(
    () =>
      measured?.proofWindows === proofWindows
        ? fitPaletteTranscriptMatches(candidates, measured.fits)
        : NO_MATCHES,
    [candidates, measured, proofWindows]
  )
  return {
    transcriptMatches,
    transcriptEligibleTabs,
    transcriptGenerationKey,
    transcriptDisplayKey: measured?.displayKey ?? '',
    transcriptSearchEnabled,
    transcriptMeasurement: { generationKey: transcriptGenerationKey, candidates, onFits }
  }
}

export type WorktreeJumpPaletteTranscriptMatches = ReturnType<
  typeof useWorktreeJumpPaletteTranscriptMatches
>
