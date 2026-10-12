import type { PaneProcessExit } from './pty-connection-types'

export function suppressIntentionalPaneCloseExit(
  transport: { getPtyId: () => string | null } | null | undefined,
  suppressPtyExit: (ptyId: string) => void
): string | null {
  const ptyId = transport?.getPtyId() ?? null
  if (ptyId) {
    suppressPtyExit(ptyId)
  }
  return ptyId
}

export function retireMountedTerminalPaneSurface(args: {
  paneKey: string
  leafId: string
  paneId: number
  tabId: string
  ptyId: string | null
  retireAgentPaneAuthority: (
    paneKey: string,
    options?: { preserveSleepingAgentSession?: boolean }
  ) => void
  syncPanePtyLayoutBinding: (paneId: number, ptyId: string | null) => void
  syncPanePtyLayoutBindingForLeaf?: (
    leafId: string,
    ptyId: string | null,
    sourcePaneId: number
  ) => void
  clearExitedPanePtyLayoutBindingForLeaf?: (leafId: string, exitedPtyId: string) => void
  clearTabPtyId: (tabId: string, ptyId: string) => void
  transport?: {
    detach?: (options?: { preserveExitObserver?: boolean }) => void
    destroy?: () => void
  }
}): void {
  args.retireAgentPaneAuthority(args.paneKey, {
    preserveSleepingAgentSession: true
  })
  if (args.ptyId) {
    if (args.clearExitedPanePtyLayoutBindingForLeaf) {
      // Match the old PTY before clearing so an overlapping successor cannot lose its binding.
      args.clearExitedPanePtyLayoutBindingForLeaf(args.leafId, args.ptyId)
    } else if (args.syncPanePtyLayoutBindingForLeaf) {
      args.syncPanePtyLayoutBindingForLeaf(args.leafId, null, args.paneId)
    } else {
      args.syncPanePtyLayoutBinding(args.paneId, null)
    }
    args.clearTabPtyId(args.tabId, args.ptyId)
  }
  args.transport?.detach?.({ preserveExitObserver: false })
}

export type { PaneProcessExit }
