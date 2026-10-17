import { describe, expect, it } from 'vitest'
import type { WorkspaceSessionState } from '../../../../../../shared/workspace-session-state-types'
import { buildOwnedEditorFileId } from '../file-ids/editor-file-ids'
import { buildHydratedEditorSessionState } from './hydrated-editor-session-state'

const SIBLING = 'repo-a::/repo-a-2'
const FILE_PATH = '/repo-a/src/a.ts'
const OWNED = buildOwnedEditorFileId(FILE_PATH, SIBLING, null)

/** A tab Orca moved to the workspace owning its file, saved under the file's owned id. */
const session: WorkspaceSessionState = {
  activeRepoId: null,
  activeWorktreeId: null,
  activeTabId: null,
  tabsByWorktree: {},
  terminalLayoutsByTabId: {},
  openFilesByWorktree: {
    [SIBLING]: [
      { filePath: FILE_PATH, relativePath: 'src/a.ts', worktreeId: SIBLING, language: 'typescript' }
    ]
  },
  unifiedTabs: {
    [SIBLING]: [
      {
        id: 'tab-1',
        entityId: OWNED,
        groupId: 'group-1',
        worktreeId: SIBLING,
        contentType: 'editor',
        label: 'a.ts',
        customLabel: null,
        color: null,
        sortOrder: 0,
        createdAt: 1
      }
    ]
  }
}

describe('buildHydratedEditorSessionState', () => {
  it('maps a moved tab’s owned id to the restored file on restart only', () => {
    const workspaces = new Set([SIBLING])
    const restart = buildHydratedEditorSessionState(session, workspaces, null, true)
    const frame = buildHydratedEditorSessionState(session, workspaces, null, false)

    expect(restart.editorFileIdMigrationsByWorktree[SIBLING]?.get(OWNED)).toBe(FILE_PATH)
    expect(frame.editorFileIdMigrationsByWorktree[SIBLING]?.get(OWNED)).toBeUndefined()
  })
})
