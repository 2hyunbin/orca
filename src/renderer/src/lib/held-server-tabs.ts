// Held tabs: tabs this desktop created in a server's workspace (desktop-created-server-tabs) while
// that server's frames draw it. Kept out of the record so store slices can import the record
// without the frame runtime.

import { isFrameDrawnServerWorkspace } from '@/runtime/web-session-tabs-sync/frame-drawn-server-workspaces'
import { desktopCreatedServerTabEnvironments } from './desktop-created-server-tabs'

/** A held tab (by tab-bar or entity id) moves only within the server's groups, which have no
 *  place for a split of its own. */
export function isHeldServerTab(workspace: string, id: string): boolean {
  return desktopCreatedServerTabEnvironments(workspace, id).some((environmentId) =>
    isFrameDrawnServerWorkspace(environmentId, workspace)
  )
}

/** A group's tabs the server's group has too: all but the held ones. */
export function serverTabCount(workspace: string, tabOrder: readonly string[]): number {
  return tabOrder.filter((id) => !isHeldServerTab(workspace, id)).length
}
