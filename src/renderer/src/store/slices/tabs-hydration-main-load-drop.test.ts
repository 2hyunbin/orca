// L286: a layout-owner build's main drops view-less saved editor tabs at load and writes that back.
// A window-owned build reading the written session must restore exactly what it did before.

import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { Tab, TabContentType } from '../../../../shared/tab-types'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { loadWorkspaceLayout } from '../../../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../../../shared/workspace-layout/workspace-layout-minted-ids'
import { saveWorkspaceLayout } from '../../../../shared/workspace-layout/workspace-layout-save'
import { buildHydratedTabState } from './tabs-hydration'

const layoutOwner = vi.hoisted(() => ({ isMain: true }))
vi.mock('../../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return layoutOwner.isMain
  }
}))

const KEY = 'repo-1::/w'

function entry(id: string, contentType: TabContentType, entityId: string, sortOrder: number): Tab {
  return {
    id,
    entityId,
    groupId: 'g1',
    worktreeId: KEY,
    contentType,
    label: id,
    customLabel: null,
    color: null,
    sortOrder,
    createdAt: 1
  }
}

function savedSession(): WorkspaceSessionState {
  const tabs = [
    entry('ghost-diff', 'diff', '/w/gone.ts', 0),
    entry('ed-a', 'editor', '/w/a.ts', 1),
    entry('ghost-review', 'conflict-review', '/w/conflict', 2),
    entry('kept-diff', 'diff', '/w/b.ts', 3),
    entry('ed-b', 'editor', '/w/b.ts', 4)
  ]
  return {
    ...getDefaultWorkspaceSession(),
    unifiedTabs: { [KEY]: tabs },
    tabGroups: {
      [KEY]: [{ id: 'g1', worktreeId: KEY, activeTabId: 'ed-a', tabOrder: tabs.map((t) => t.id) }]
    },
    openFilesByWorktree: {
      [KEY]: ['/w/a.ts', '/w/b.ts'].map((filePath) => ({
        filePath,
        relativePath: filePath.slice(3),
        worktreeId: KEY,
        language: 'typescript'
      }))
    }
  }
}

describe("a window-owned build reading a session main's load rewrote", () => {
  it('restores the same tabs and groups as from the session before the rewrite', () => {
    layoutOwner.isMain = true
    const rewritten = saveWorkspaceLayout(
      loadWorkspaceLayout(LOCAL_EXECUTION_HOST_ID, savedSession(), nameBasedLoadContext())
    )
    layoutOwner.isMain = false

    const restore = (session: WorkspaceSessionState) => {
      const state = buildHydratedTabState(session, new Set([KEY]))
      return {
        tabs: state.unifiedTabsByWorktree[KEY]?.map((tab) => [tab.id, tab.contentType]),
        groups: state.groupsByWorktree[KEY]?.map((group) => group.tabOrder)
      }
    }
    expect(restore(rewritten)).toEqual(restore(savedSession()))
    expect(restore(rewritten).groups).toEqual([['ed-a', 'kept-diff', 'ed-b']])
  })
})
