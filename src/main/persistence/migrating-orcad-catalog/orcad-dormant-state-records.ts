import {
  initializeCanonicalLineage,
  writeCanonicalLineage
} from '../loading-store/canonical-workspace-lineage'
import type {
  OrcadMigrationDormantStatePayload,
  OrcadMigrationManifest
} from '../../../shared/orcad-migration-manifest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { SparsePreset } from '../../../shared/worktree/create-types'
import type { LineageEdge } from '../../../shared/worktree/lineage-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { omitDefaultWorktreeMetaFields } from '../../../shared/worktree/meta-persisted-defaults'
import { assertOrcadDestinationCanonicalMetadata } from './orcad-destination-worktree-metadata'
import { assertSameValue } from './orcad-catalog-row-identity'
import {
  mergeRetiredNameRegistries,
  type RetiredNameRegistry
} from '../../../shared/worktree/retired-name-registry'
import { recordRetirementNamespaceRegistry } from '../../worktree-retirement-namespace'
import {
  applyPreparedOrcadMigrationWorkspaceSession,
  prepareOrcadMigrationWorkspaceSession,
  type PreparedOrcadMigrationWorkspaceSession
} from './orcad-destination-workspace-session'
import {
  applyPreparedOrcadMigrationAutomationState,
  prepareOrcadMigrationAutomationState,
  type PreparedOrcadMigrationAutomationState
} from './orcad-destination-automation-state'
import {
  applyPreparedOrcadMigrationClientState,
  prepareOrcadMigrationClientState,
  type PreparedOrcadMigrationClientState
} from './orcad-destination-client-state'

type KeyedRow<T> = { key: string; value: T }
type RegistryUpdate = { key: string; value: RetiredNameRegistry }

export type PreparedOrcadMigrationDormantState = {
  payload: OrcadMigrationDormantStatePayload | undefined
  newLineageEdges: KeyedRow<LineageEdge>[]
  newWorktreeMeta: KeyedRow<WorktreeMeta>[]
  newSparsePresets: SparsePreset[]
  retiredNameUpdates: RegistryUpdate[]
  retirementNamespaceUpdates: RegistryUpdate[]
  workspaceSession: PreparedOrcadMigrationWorkspaceSession
  automationState: PreparedOrcadMigrationAutomationState
  clientState: PreparedOrcadMigrationClientState
}

export function prepareOrcadMigrationDormantState(
  manifest: OrcadMigrationManifest,
  state: PersistedState
): PreparedOrcadMigrationDormantState {
  const payload = manifest.payload.dormantState
  if (!payload) {
    return emptyPreparedDormantState()
  }
  assertOrcadDestinationCanonicalMetadata(state, payload.worktreeMeta)
  const worktreeMeta = payload.worktreeMeta.map((entry) => ({
    key: entry.worktreeId,
    value: structuredClone(entry.meta)
  }))
  const incoming: PersistedState = {
    ...state,
    lineageByChildInstance: undefined,
    worktreeLineageById: Object.fromEntries(
      payload.worktreeLineage.map((entry) => [entry.worktreeId, entry.lineage])
    ),
    workspaceLineageByChildKey: Object.fromEntries(
      payload.workspaceLineage.map((entry) => [entry.childWorkspaceKey, entry.lineage])
    )
  }
  initializeCanonicalLineage(incoming)
  const existingPresets = new Map(
    Object.values(state.sparsePresetsByRepo)
      .flat()
      .map((preset) => [sparsePresetKey(preset), preset])
  )
  const newSparsePresets = payload.sparsePresets.filter((preset) => {
    const existing = existingPresets.get(sparsePresetKey(preset))
    if (!existing) {
      return true
    }
    assertSameValue(existing, preset, `sparse_preset:${preset.repoId}:${preset.id}`)
    return false
  })
  return {
    payload,
    newLineageEdges: selectNewKeyedRows(
      (payload.edges ?? Object.values(incoming.lineageByChildInstance ?? {})).map((edge) => ({
        key: edge.child.instanceId,
        value: { ...structuredClone(edge), child: { ...edge.child, hostId: 'local' as const } }
      })),
      state.lineageByChildInstance ?? {},
      'lineage_edge'
    ),
    newWorktreeMeta: selectNewKeyedRows(
      worktreeMeta,
      state.worktreeMeta,
      'worktree_meta',
      omitDefaultWorktreeMetaFields
    ),
    newSparsePresets,
    retiredNameUpdates: payload.retiredWorktreeNames.map((entry) => ({
      key: entry.repoId,
      value: mergeRetiredNameRegistries(
        state.retiredWorktreeNamesByRepo?.[entry.repoId] ?? { exhaustedTiers: 0, names: [] },
        entry.registry
      )
    })),
    retirementNamespaceUpdates: payload.retiredWorktreeNamespaces.map((entry) => ({
      key: entry.namespaceKey,
      value: mergeRetiredNameRegistries(
        state.retiredWorktreeNamesByNamespace?.[entry.namespaceKey] ?? {
          exhaustedTiers: 0,
          names: []
        },
        entry.registry
      )
    })),
    workspaceSession: prepareOrcadMigrationWorkspaceSession(payload.workspaceSession, state),
    automationState: prepareOrcadMigrationAutomationState(
      payload.automations,
      payload.automationRuns,
      state
    ),
    clientState: prepareOrcadMigrationClientState(payload.clientState, state)
  }
}

export function applyPreparedOrcadMigrationDormantState(
  prepared: PreparedOrcadMigrationDormantState,
  state: PersistedState
): void {
  for (const entry of prepared.newWorktreeMeta) {
    state.worktreeMeta[entry.key] = entry.value
  }
  for (const { value: edge } of prepared.newLineageEdges) {
    writeCanonicalLineage(state, edge)
  }
  for (const preset of prepared.newSparsePresets) {
    state.sparsePresetsByRepo[preset.repoId] = [
      ...(state.sparsePresetsByRepo[preset.repoId] ?? []),
      preset
    ]
  }
  if (prepared.retiredNameUpdates.length > 0) {
    state.retiredWorktreeNamesByRepo ??= {}
    for (const entry of prepared.retiredNameUpdates) {
      state.retiredWorktreeNamesByRepo[entry.key] = entry.value
    }
  }
  if (prepared.retirementNamespaceUpdates.length > 0) {
    state.retiredWorktreeNamesByNamespace ??= {}
    for (const entry of prepared.retirementNamespaceUpdates) {
      recordRetirementNamespaceRegistry(
        state.retiredWorktreeNamesByNamespace,
        entry.key,
        entry.value
      )
    }
  }
  applyPreparedOrcadMigrationWorkspaceSession(prepared.workspaceSession, state)
  applyPreparedOrcadMigrationAutomationState(prepared.automationState, state)
  applyPreparedOrcadMigrationClientState(prepared.clientState, state)
}

function selectNewKeyedRows<T>(
  incoming: KeyedRow<T>[],
  existing: Record<string, T>,
  label: string,
  canonicalize: (value: T) => T = (value) => value
): KeyedRow<T>[] {
  return incoming.filter((entry) => {
    const current = existing[entry.key]
    if (current === undefined) {
      return true
    }
    assertSameValue(canonicalize(current), canonicalize(entry.value), `${label}:${entry.key}`)
    return false
  })
}

const sparsePresetKey = (preset: Pick<SparsePreset, 'id' | 'repoId'>): string =>
  `${preset.repoId}\0${preset.id}`

function emptyPreparedDormantState(): PreparedOrcadMigrationDormantState {
  return {
    payload: undefined,
    newWorktreeMeta: [],
    newLineageEdges: [],
    newSparsePresets: [],
    retiredNameUpdates: [],
    retirementNamespaceUpdates: [],
    workspaceSession: { incoming: undefined, merged: undefined },
    automationState: {
      incomingAutomations: [],
      incomingRuns: [],
      newAutomations: [],
      newRuns: []
    },
    clientState: {
      incoming: undefined,
      mobileSelections: {},
      uiRouting: undefined
    }
  }
}
