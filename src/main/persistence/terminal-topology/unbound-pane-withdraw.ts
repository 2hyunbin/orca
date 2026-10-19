import type { ExecutionHostId } from '../../../shared/execution-host'
import type {
  CommandOf,
  LayoutRefusalCode
} from '../../../shared/workspace-layout/workspace-layout-command-types'
import type { DurableProfileStateMutation } from '../loading-store/store-runtime-state'
import { withdrawPane, type TerminalTopologyCommitContext } from './terminal-topology-commit'

/** `withdrawPane`, unless the pane's terminal has bound since: then 'bound', and nothing is written. */
export function withdrawUnboundPane(
  hostId: ExecutionHostId,
  pane: CommandOf<'closePane'>,
  context: TerminalTopologyCommitContext
): () => DurableProfileStateMutation<LayoutRefusalCode | 'bound' | null> {
  const withdraw = withdrawPane(hostId, pane, context)
  return () =>
    context.getSession(hostId).terminalLayoutsByTabId?.[pane.tabId]?.ptyIdsByLeafId?.[pane.leafId]
      ? { value: 'bound', persist: false }
      : withdraw()
}
