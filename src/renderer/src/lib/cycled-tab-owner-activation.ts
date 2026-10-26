import { useAppStore } from '@/store'
import type { TypeCyclableTab } from '@/components/terminal/tab-type-cycle'
import { activateStructuredAgentSessionTabOnOwner } from '@/lib/agent-session/structured-agent-session-tab-activation'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/worktree-runtime-owner'
import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session-environment'
import {
  activateBrowserTabOnOwner,
  activateTerminalTabOnOwner
} from './terminal-tab-owner-activation'

/** Keyboard switches must reach the owner like clicks, or a server workspace reopens on its stale pick. */
export function activateCycledTabOnOwner(worktreeId: string | null, next: TypeCyclableTab): void {
  if (!worktreeId) {
    return
  }
  if (next.type === 'terminal') {
    const leafId = useAppStore.getState().terminalLayoutsByTabId?.[next.id]?.activeLeafId ?? null
    activateTerminalTabOnOwner(worktreeId, next.id, leafId)
  } else if (next.type === 'browser' && next.tabId) {
    activateBrowserTabOnOwner(worktreeId, next.tabId, next.id)
  } else if (next.type === 'agent-session') {
    // Why server-only: a local activation would make paired phones follow every intermediate stop.
    const environmentId = runtimeEnvironmentIdOrLocalUnlessTwin(useAppStore.getState(), worktreeId)
    if (environmentId && isWebRuntimeSessionActive(environmentId)) {
      activateStructuredAgentSessionTabOnOwner(worktreeId, next.id)
    }
  }
}
