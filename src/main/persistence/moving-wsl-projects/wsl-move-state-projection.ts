/**
 * Host-neutral projection of everything a WSL project move must carry, used as the losslessness
 * oracle: `project(source before) == project(destination after)`. It reads the stores directly
 * rather than the mover's export, so a row the export forgets shows up as a difference.
 *
 * Normalization: UNC paths of the scoped distro become Linux paths (also inside worktree ids,
 * owner keys, editor file ids and `file:` URLs), every alias of the owning host becomes `<H>`,
 * PTY bindings, host bindings and re-derived fields are dropped, and object keys are sorted.
 */
import { getAutomationRunRepoId } from '../../../shared/automation-run-identity'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { PersistedUIState } from '../../../shared/persisted-ui-state-types'
import { WORKSPACE_SESSION_FIELD_OWNERSHIP } from '../../../shared/workspace-session-host-field-ownership'
import {
  buildWorktreeIdByFileId,
  buildWorktreeIdByTabId,
  worktreeIdForPaneKey
} from '../../../shared/workspace-session-host-records'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  normalizeWorkspaceSessionKeyToWorkspaceId,
  parseWorkspaceKey
} from '../../../shared/workspace-scope'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import {
  canonicalizeWslMoveValue,
  createWslMoveStringNormalizer,
  isRecord,
  parseEditorFileId
} from './wsl-move-canonical-form'
import {
  WORKSPACE_SESSION_DISPOSITIONS,
  WSL_MOVE_DROPPED_PTY_BINDING_KEYS
} from './wsl-move-dispositions'
import { UI_STATE_DISPOSITIONS } from './wsl-move-ui-dispositions'

export type WslMoveProjectionScope = {
  distro: string
  repoIds: ReadonlySet<string>
  folderWorkspaceIds: ReadonlySet<string>
  /** Every id the owning host goes by on this side: `local`, `runtime:wsl:<d>`, `wsl:<d>`. */
  hostAliases: readonly string[]
}

export type WslMoveProjectionInput = {
  state: Pick<
    PersistedState,
    | 'repos'
    | 'projects'
    | 'projectGroups'
    | 'folderWorkspaces'
    | 'sparsePresetsByRepo'
    | 'retiredWorktreeNamesByRepo'
    | 'worktreeMeta'
    | 'worktreeLineageById'
    | 'workspaceLineageByChildKey'
    | 'automations'
    | 'automationRuns'
  >
  /** The partition that holds the scoped projects on this side. */
  session: Partial<WorkspaceSessionState>
  ui?: Partial<PersistedUIState>
}

type OwnerInScope = (owner: string | undefined | null) => boolean
type SessionOwnership =
  (typeof WORKSPACE_SESSION_FIELD_OWNERSHIP)[keyof typeof WORKSPACE_SESSION_FIELD_OWNERSHIP]

/** Fields that name the host a row runs on: exactly what a move changes, so never compared. */
const HOST_BINDING_KEYS = [
  'connectionId',
  'executionHostId',
  'hostId',
  'executionTargetGeneration',
  'localWindowsRuntimePreference',
  // Re-derived on the destination (item 4); compared through the projectId it resolves to.
  'projectHostSetupId'
] as const

const SESSION_OWNERSHIP_BY_FIELD: ReadonlyMap<string, SessionOwnership> = new Map(
  Object.entries(WORKSPACE_SESSION_FIELD_OWNERSHIP)
)

const DROPPED_KEYS: ReadonlySet<string> = new Set([
  ...WSL_MOVE_DROPPED_PTY_BINDING_KEYS,
  ...HOST_BINDING_KEYS
])

export function projectWslMoveState(
  input: WslMoveProjectionInput,
  scope: WslMoveProjectionScope
): unknown {
  const ownerInScope: OwnerInScope = (owner) => {
    if (!owner) {
      return false
    }
    const parsed = parseWorkspaceKey(owner)
    if (parsed?.type === 'folder') {
      return scope.folderWorkspaceIds.has(parsed.folderWorkspaceId)
    }
    const id = normalizeWorkspaceSessionKeyToWorkspaceId(owner)
    return scope.folderWorkspaceIds.has(id) || scope.repoIds.has(getRepoIdFromWorktreeId(id))
  }
  const { state } = input
  const automations = state.automations.filter((automation) =>
    scope.repoIds.has(getAutomationRunRepoId(automation))
  )
  const automationIds = new Set(automations.map((automation) => automation.id))
  const inScopeRow = (row: { id: string }): boolean =>
    scope.repoIds.has(row.id) || scope.folderWorkspaceIds.has(row.id)
  const projection = {
    repos: state.repos.filter(inScopeRow),
    projects: state.projects.filter((project) =>
      project.sourceRepoIds.some((repoId) => scope.repoIds.has(repoId))
    ),
    folderWorkspaces: state.folderWorkspaces.filter(inScopeRow),
    projectGroups: state.projectGroups.filter((group) =>
      [...state.repos, ...state.folderWorkspaces].some(
        (row) => row.projectGroupId === group.id && inScopeRow(row)
      )
    ),
    sparsePresetsByRepo: pickKeys(state.sparsePresetsByRepo, (key) => scope.repoIds.has(key)),
    retiredWorktreeNamesByRepo: pickKeys(state.retiredWorktreeNamesByRepo ?? {}, (key) =>
      scope.repoIds.has(key)
    ),
    worktreeMeta: pickKeys(state.worktreeMeta, ownerInScope),
    worktreeLineageById: pickKeys(state.worktreeLineageById, ownerInScope),
    workspaceLineageByChildKey: pickKeys(state.workspaceLineageByChildKey, ownerInScope),
    automations,
    automationRuns: state.automationRuns.filter((run) => automationIds.has(run.automationId)),
    session: projectSession(input.session, ownerInScope),
    ui: projectUi(input.ui ?? {}, input.session, ownerInScope, scope)
  }
  const canonical = canonicalizeWslMoveValue(
    projection,
    createWslMoveStringNormalizer(scope),
    DROPPED_KEYS
  )
  dropSelfPriorIds(canonical)
  return canonical
}

/** The mover appends each worktree's own UNC id to `priorWorktreeIds` (item 14); after
 *  normalization that is the worktree's own id, which carries no history to compare. */
function dropSelfPriorIds(canonical: unknown): void {
  const meta = fieldOf(canonical, 'worktreeMeta')
  if (!isRecord(meta)) {
    return
  }
  for (const [worktreeId, row] of Object.entries(meta)) {
    const prior = fieldOf(row, 'priorWorktreeIds')
    if (isRecord(row) && Array.isArray(prior)) {
      const kept = prior.filter((id) => id !== worktreeId)
      if (kept.length > 0) {
        row.priorWorktreeIds = kept
      } else {
        delete row.priorWorktreeIds
      }
    }
  }
}

function projectSession(
  session: Partial<WorkspaceSessionState>,
  ownerInScope: OwnerInScope
): Record<string, unknown> {
  const byTab = buildWorktreeIdByTabId(session)
  const byFile = buildWorktreeIdByFileId(session)
  const fields: Readonly<Record<string, unknown>> = session
  const out: Record<string, unknown> = {}
  for (const [field, row] of Object.entries(WORKSPACE_SESSION_DISPOSITIONS)) {
    const value = fields[field]
    const ownership = SESSION_OWNERSHIP_BY_FIELD.get(field)
    if (row.disposition !== 'move' || value == null || !ownership) {
      continue
    }
    const owned = projectSessionField(ownership, value, ownerInScope, byTab, byFile)
    if (owned !== undefined) {
      out[field] = owned
    }
  }
  return out
}

function projectSessionField(
  ownership: SessionOwnership,
  value: unknown,
  ownerInScope: OwnerInScope,
  byTab: Map<string, string>,
  byFile: Map<string, string>
): unknown {
  const record = isRecord(value) ? value : {}
  switch (ownership) {
    case 'worktreeKeyed':
      return pickKeys(record, ownerInScope)
    case 'worktreeArray':
      return Array.isArray(value) ? value.filter((id) => ownerInScope(String(id))) : undefined
    case 'tabKeyed':
      return pickKeys(record, (tabId) => ownerInScope(byTab.get(tabId)))
    case 'paneKeyed':
      return pickKeys(record, (paneKey) => ownerInScope(worktreeIdForPaneKey(byTab, paneKey)))
    case 'fileKeyed':
      return pickKeys(record, (fileId) =>
        ownerInScope(parseEditorFileId(fileId)?.[0] ?? byFile.get(fileId))
      )
    case 'sleepingAgentKeyed':
    case 'surfaceTombstoneKeyed':
      return pickEntries(record, (entry) => ownerInScope(rowOwner(entry)))
    case 'browserWorkspaceKeyed':
      return pickEntries(
        record,
        (pages) => Array.isArray(pages) && pages.some((page) => ownerInScope(rowOwner(page)))
      )
    case 'global':
      // Only global history rows that name a scoped workspace move; focus is re-projected and
      // per-environment browser intents stay with the client that owes them.
      return Array.isArray(value)
        ? value.filter((row) =>
            ownerInScope(
              rowOwner(isRecord(row) && isRecord(row.docLocation) ? row.docLocation : row)
            )
          )
        : undefined
    case 'hostPrivate':
      return undefined
  }
}

function projectUi(
  ui: Partial<PersistedUIState>,
  session: Partial<WorkspaceSessionState>,
  ownerInScope: OwnerInScope,
  scope: WslMoveProjectionScope
): Record<string, unknown> {
  const byTab = buildWorktreeIdByTabId(session)
  const out: Record<string, unknown> = {}
  const fields: Readonly<Record<string, unknown>> = ui
  for (const [field, row] of Object.entries(UI_STATE_DISPOSITIONS)) {
    const value = fields[field]
    if (row.disposition !== 'move' || value == null) {
      continue
    }
    if (Array.isArray(value)) {
      // Repo-id lists, and the manual repo order's `{hostId, repoId}` rows.
      out[field] = value.filter((entry: unknown) =>
        scope.repoIds.has(typeof entry === 'string' ? entry : String(fieldOf(entry, 'repoId')))
      )
    } else if (field.endsWith('ByPaneKey') && isRecord(value)) {
      out[field] = pickKeys(value, (paneKey) => ownerInScope(worktreeIdForPaneKey(byTab, paneKey)))
    } else if (field === 'workspaceCleanup' && isRecord(value) && isRecord(value.dismissals)) {
      out[field] = pickKeys(value.dismissals, ownerInScope)
    } else if (typeof value === 'string') {
      out[field] = ownerInScope(value) ? value : null
    } else if (isRecord(value)) {
      out[field] = pickKeys(value, ownerInScope)
    }
  }
  return out
}

function rowOwner(row: unknown): string | undefined {
  const id = fieldOf(row, 'worktreeId') ?? fieldOf(row, 'workspaceId')
  return typeof id === 'string' ? id : undefined
}

function fieldOf(row: unknown, key: string): unknown {
  return isRecord(row) ? row[key] : undefined
}

function pickKeys<T>(
  record: Readonly<Record<string, T>>,
  keep: (key: string) => boolean
): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => keep(key)))
}

function pickEntries<T>(
  record: Readonly<Record<string, T>>,
  keep: (entry: T) => boolean
): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([, entry]) => keep(entry)))
}
