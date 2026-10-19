import type {
  OrcadMigrationCatalogPayload,
  OrcadMigrationManifestSource
} from '../../../shared/orcad-migration/orcad-migration-manifest'
import type { OrcadMigrationTerminalScrollbackSnapshot } from '../../../shared/orcad-migration/orcad-migration-scrollback'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { keepUnsavedDrafts } from '../../../shared/workspace-session-draft-retention'
import {
  filterWorkspaceRows,
  withoutWorkspaces
} from '../../../shared/workspace-session-stranded-partition-adoption'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  createOrcadMigrationSourceScope,
  orcadMigrationOwnerMatchesScope,
  orcadMigrationPartitionScope
} from './orcad-source-scope'
import { unsavedDraftItems, worktreeLabel } from './orcad-source-workspace-session-eligibility'
import { isHostBoundOpenFile } from './orcad-source-draft-rename'

// What "Move anyway" does with the desktop's own copy of a moving host's saved session.

export type SessionFragment = {
  session: WorkspaceSessionState
  snapshots: OrcadMigrationTerminalScrollbackSnapshot[]
  local: boolean
  sourceHost: boolean
}

/** Unsaved drafts in this desktop's own session for the source's worktrees that the commit
 *  cannot rename to the server: another host's files. */
export function uncarriedDesktopDrafts(
  state: PersistedState,
  source: OrcadMigrationManifestSource,
  catalog: OrcadMigrationCatalogPayload
): string[] {
  const scope = orcadMigrationPartitionScope(
    createOrcadMigrationSourceScope({ source, catalog, repos: state.repos }),
    LOCAL_EXECUTION_HOST_ID
  )
  return Object.entries(state.workspaceSession.openFilesByWorktree ?? {}).flatMap(
    ([ownerKey, files]) =>
      orcadMigrationOwnerMatchesScope(ownerKey, scope)
        ? unsavedDraftItems(files.filter(isHostBoundOpenFile), ownerKey)
        : []
  )
}

export function clashingDraftItem(filePath: string, ownerKey: string): string {
  return `two different unsaved versions of ${filePath} in ${worktreeLabel(ownerKey)}`
}

/**
 * The desktop's copy of each conflicting worktree gives way to the host's, keeping its unsaved
 * drafts. Two different drafts of one file can't both move, so those still refuse.
 */
export function resolveCopiesForHost(
  fragments: readonly SessionFragment[],
  conflicting: ReadonlySet<string>
): { fragments: SessionFragment[]; clashingDrafts: string[] } {
  const desktop = fragments.filter((fragment) => fragment.local)
  const desktopRows = desktop.map((fragment) =>
    filterWorkspaceRows(fragment.session, (workspaceId) => conflicting.has(workspaceId))
  )
  // With no host copy the desktop's drafts still reach the server: the commit renames them.
  const clashingDrafts: string[] = []
  const resolved = fragments.map((fragment): SessionFragment => {
    if (fragment.local) {
      const session = withoutWorkspaces(fragment.session, conflicting)
      const layouts = new Set(Object.keys(session.terminalLayoutsByTabId))
      return {
        ...fragment,
        session,
        snapshots: fragment.snapshots.filter((snapshot) => layouts.has(snapshot.tabId))
      }
    }
    if (!fragment.sourceHost) {
      return fragment
    }
    const session = structuredClone(fragment.session)
    for (const rows of desktopRows) {
      for (const [ownerKey, files] of Object.entries(rows.openFilesByWorktree ?? {})) {
        const hostFiles = new Map(
          (session.openFilesByWorktree?.[ownerKey] ?? []).map((file) => [file.filePath, file])
        )
        for (const file of files) {
          const held = hostFiles.get(file.filePath)
          if (
            file.dirtyDraftContent !== undefined &&
            held?.dirtyDraftContent !== undefined &&
            held.dirtyDraftContent !== file.dirtyDraftContent
          ) {
            clashingDrafts.push(clashingDraftItem(file.filePath, ownerKey))
          }
        }
      }
      keepUnsavedDrafts(session, rows)
    }
    return { ...fragment, session }
  })
  return { fragments: resolved, clashingDrafts }
}
