// Main's closed-pane record (L80 Q2) is a session field every per-field table must place, and one
// a build that predates it drops without losing anything else.
import { describe, expect, it } from 'vitest'
import { WORKSPACE_SESSION_FIELD_DISPOSITION } from '../orca-profiles/profile-project-session-field-disposition'
import { WORKSPACE_SESSION_WORKTREE_REFERENCE_KIND } from './restoring-sessions/session-worktree-ownership'
import { WORKSPACE_SESSION_FIELD_OWNERSHIP } from '../../shared/workspace-session-host-field-ownership'
import { SESSION_FIELD_OWNERS } from '../../shared/workspace-layout/workspace-layout-beside'
import { WORKSPACE_SESSION_DISPOSITIONS } from '../../shared/wsl-move/wsl-move-dispositions'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { parseWorkspaceSession } from '../../shared/workspace-session-schema'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

const FIELD = 'closedTerminalPanesByPaneKey'

const session: WorkspaceSessionState = {
  ...getDefaultWorkspaceSession(),
  closedTerminalPanesByPaneKey: {
    'tab-1:leaf-1': { ptyId: 'pty-1', incarnationId: 'inc-1', worktreeId: 'repo::/w', closedAt: 1 }
  }
}

describe('main’s closed-pane record', () => {
  it.each([
    ['host-field ownership', WORKSPACE_SESSION_FIELD_OWNERSHIP],
    ['WSL move dispositions', WORKSPACE_SESSION_DISPOSITIONS],
    ['profile project dispositions', WORKSPACE_SESSION_FIELD_DISPOSITION],
    ['worktree reference kinds', WORKSPACE_SESSION_WORKTREE_REFERENCE_KIND],
    ['layout field owners', SESSION_FIELD_OWNERS]
  ])('is placed in the %s table', (_name, table) => {
    expect(Object.hasOwn(table, FIELD)).toBe(true)
  })

  it('survives this build’s session parse', () => {
    const parsed = parseWorkspaceSession(session)
    expect(parsed.ok && parsed.value.closedTerminalPanesByPaneKey).toEqual(
      session.closedTerminalPanesByPaneKey
    )
  })

  it('is dropped, alone, by a build that predates it', () => {
    // A build before L80 reads the field as one it does not know: its session parse strips unknown
    // fields and keeps the rest, as this build's does for a field from a newer one.
    const { [FIELD]: records, ...rest } = session
    const asOlder = { ...rest, closedTerminalPanesFromANewerBuild: records }
    const parsed = parseWorkspaceSession(asOlder)
    expect(parsed).toEqual(parseWorkspaceSession(rest))
    expect(parsed.ok && parsed.value).not.toHaveProperty('closedTerminalPanesFromANewerBuild')
  })
})
