// A chat this desktop opens in a workspace its server's frames draw (L270): the frames keep the
// provisional tab, through the created-here hold, until the server lists it; the create names the
// tab's place in the server's ids, so the server saves it there instead of at the group's end.

import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { StructuredAgentSessionCreateParams } from '../../../shared/structured-agent-session-create'
import { AGENT_SESSION_CREATE_TAB_PLACEMENT_RUNTIME_CAPABILITY } from '../../../shared/agent-session-create-capabilities'
import { structuredAgentSessionTabId } from '../../../shared/structured-agent-session-projection'
import { useAppStore } from '@/store'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/runtime-rpc-client'
import { serverTabIdOf } from '@/runtime/server-layout-frame-ids'
import { isFrameDrawnServerWorkspace } from '@/runtime/web-session-tabs-sync/frame-drawn-server-workspaces'
import {
  isDesktopCreatedServerTab,
  noteDesktopCreatedServerTab
} from './desktop-created-server-tabs'

function frameDrawnEnvironment(
  target: RuntimeClientTarget | null,
  worktreeId: string
): string | null {
  return target?.kind === 'environment' &&
    isFrameDrawnServerWorkspace(target.environmentId, worktreeId)
    ? target.environmentId
    : null
}

/** Before the server saves the chat, its frames would drop the tab and redraw it at the end. */
export function holdFrameDrawnProvisionalChatTab(
  target: RuntimeClientTarget | null,
  worktreeId: string,
  tabId: string
): void {
  const environmentId = frameDrawnEnvironment(target, worktreeId)
  if (environmentId) {
    noteDesktopCreatedServerTab(environmentId, worktreeId, tabId)
  }
}

type TabPlacement = NonNullable<StructuredAgentSessionCreateParams['tabPlacement']>

/** The chat tab's group, and the server tab before it there; this desktop's own tabs are skipped. */
function chatTabPlacement(worktreeId: string, tabId: string): TabPlacement | undefined {
  const state = useAppStore.getState()
  const group = state.groupsByWorktree[worktreeId]?.find((entry) => entry.tabOrder.includes(tabId))
  if (!group) {
    return undefined
  }
  const tabs = state.unifiedTabsByWorktree[worktreeId]
  const afterTabId = group.tabOrder
    .slice(0, group.tabOrder.indexOf(tabId))
    .findLast((id) => !isDesktopCreatedServerTab(tabs, worktreeId, id))
  return { groupId: group.id, ...(afterTabId ? { afterTabId: serverTabIdOf(afterTabId) } : {}) }
}

/** The create's params, with the tab's place when the host takes one. Read as the create is sent. */
export async function withFrameDrawnChatTabPlacement(intent: {
  target: RuntimeClientTarget
  worktreeId: string
  sessionId: string
  params: StructuredAgentSessionCreateParams
}): Promise<StructuredAgentSessionCreateParams> {
  const environmentId = frameDrawnEnvironment(intent.target, intent.worktreeId)
  if (!environmentId) {
    return intent.params
  }
  let supported = false
  try {
    supported = await runtimeEnvironmentSupportsCapability(
      environmentId,
      AGENT_SESSION_CREATE_TAB_PLACEMENT_RUNTIME_CAPABILITY
    )
  } catch {
    // Unknown capability: an older host refuses the field.
  }
  const tabPlacement = supported
    ? chatTabPlacement(intent.worktreeId, structuredAgentSessionTabId(intent.sessionId))
    : undefined
  return tabPlacement ? { ...intent.params, tabPlacement } : intent.params
}
