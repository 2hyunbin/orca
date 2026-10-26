import { makePaneKey } from '../../../../shared/stable-pane-id'

/** Detaches a pane the host moved to another tab, leaving its PTY running for that tab. */
export function detachExternallyMovedPane(args: {
  manager: {
    getLeafId: (paneId: number) => string | null
    detachPaneForExternalMove: (paneId: number) => boolean
  }
  paneId: number
  tabId: string
  /** The pane that binds the PTY now, in the tab the host moved it to. */
  movedTo: { tabId: string; leafId: string }
  ptyId: string
  transferAgentPaneAuthority: (args: {
    fromPaneKey: string
    toPaneKey: string
    ptyId: string
  }) => void
}): void {
  const leafId = args.manager.getLeafId(args.paneId)
  if (!args.manager.detachPaneForExternalMove(args.paneId) || !leafId) {
    return
  }
  // Why: the agent's status, unread marks, launch and sleeping records follow the pane to its new
  // tab, as a local move's do; a key this window already moved there is a no-op transfer.
  args.transferAgentPaneAuthority({
    fromPaneKey: makePaneKey(args.tabId, leafId),
    toPaneKey: makePaneKey(args.movedTo.tabId, args.movedTo.leafId),
    ptyId: args.ptyId
  })
}
