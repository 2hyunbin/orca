import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { isWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { parseRemoteRuntimePtyId } from '../../../shared/remote-runtime-pty-id'
import { runtimeEnvironmentIdUnlessTwin } from '../lib/resolve-owner'
import { useAppStore } from '../store'
import type { WebRuntimeSplitSource } from './web-runtime-split-focus'

/**
 * The terminal the workspace's server published for a pane of one of its tabs, before this pane's
 * own attach lands. A binding naming any other server is not this pane's terminal.
 */
export function readHostPublishedSplitSourcePtyId(source: WebRuntimeSplitSource): string | null {
  if (!isWebTerminalSurfaceTabId(source.tabId)) {
    return null
  }
  const state = useAppStore.getState()
  const ptyId = state.terminalLayoutsByTabId[source.tabId]?.ptyIdsByLeafId?.[source.leafId]
  const environmentId = runtimeEnvironmentIdUnlessTwin(state, source.worktreeId)
  return ptyId && environmentId && parseRemoteRuntimePtyId(ptyId)?.environmentId === environmentId
    ? ptyId
    : null
}

/** A pane of a paired server's tab: only that server starts terminals in it. */
export function isHostTabPane(source: WebRuntimeSplitSource): boolean {
  return (
    isWebTerminalSurfaceTabId(source.tabId) &&
    runtimeEnvironmentIdUnlessTwin(useAppStore.getState(), source.worktreeId) !== null
  )
}

/** The split needs the server's terminal for its source pane; until then, say so instead of splitting. */
export function notifyHostSplitSourceNotStarted(): void {
  toast.error(
    translate(
      'auto.runtime.webRuntimeSession.splitSourceUnpublished',
      'The pane didn’t split: its terminal hasn’t started on the host yet.'
    ),
    // Why an id: repeated presses while the terminal starts must not stack toasts.
    { id: 'web-runtime-split-source-not-started' }
  )
}
