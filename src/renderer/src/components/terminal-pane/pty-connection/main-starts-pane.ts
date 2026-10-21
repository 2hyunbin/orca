import { useAppStore } from '@/store'
import { runtimeEnvironmentIdUnlessTwin } from '@/lib/resolve-owner'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/layout-owner-switch'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

/** Whether main starts this pane's terminal: a layout-owner build, and main owns the workspace. */
export function mainStartsPane(session: {
  deps: ConnectPanePtySession['deps']
  runtimeEnvironmentId?: string | null
}): boolean {
  return (
    ORCA_LAYOUT_OWNER_IS_MAIN &&
    !session.runtimeEnvironmentId &&
    !runtimeEnvironmentIdUnlessTwin(useAppStore.getState(), session.deps.worktreeId)
  )
}
