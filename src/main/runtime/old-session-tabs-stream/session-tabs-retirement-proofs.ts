// Retirement proofs for old desktops' orphan recovery (`retiredTerminalSurfaces`): a pane that
// showed a terminal a client held a handle for, and then left the layout, was closed, not lost.

import type { RuntimeMobileSessionRetiredTerminalSurface } from '../../../shared/runtime-session-contracts'
import { appendRetiredTerminalSurfaceProofs } from '../../../shared/terminal-retirement-proof-ledger'
import type { PublishedWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-published'

type BoundPane = { parentTabId: string; leafId: string; ptyId: string }

/** The terminal handle a client was given for this terminal, if any. */
export type IssuedHandleOf = (ptyId: string) => string | null

export class SessionTabsRetirementProofs {
  private readonly boundPanes = new Map<string, Map<string, BoundPane>>()
  private readonly proofs = new Map<string, RuntimeMobileSessionRetiredTerminalSurface[]>()

  constructor(private readonly issuedHandleOf: IssuedHandleOf) {}

  /** A workspace was published: each bound pane it no longer shows is proven retired. */
  published(key: string, layout: PublishedWorkspaceLayout | null): void {
    const before = this.boundPanes.get(key)
    const after = layout ? boundPanesOf(layout) : new Map<string, BoundPane>()
    if (layout) {
      this.boundPanes.set(key, after)
    } else {
      this.boundPanes.delete(key)
      this.proofs.delete(key)
      return
    }
    const retired = [...(before?.values() ?? [])].flatMap((pane) => {
      const terminal = after.has(pane.leafId) ? null : this.issuedHandleOf(pane.ptyId)
      return terminal ? [{ ...pane, terminal }] : []
    })
    if (retired.length > 0) {
      this.proofs.set(key, appendRetiredTerminalSurfaceProofs(this.proofs.get(key), retired))
    }
  }

  of(key: string): RuntimeMobileSessionRetiredTerminalSurface[] | undefined {
    return this.proofs.get(key)
  }
}

function boundPanesOf(layout: PublishedWorkspaceLayout): Map<string, BoundPane> {
  const panes = new Map<string, BoundPane>()
  for (const tab of layout.tabs) {
    for (const pane of tab.terminal?.panes ?? []) {
      if (pane.ptyId) {
        panes.set(pane.leafId, {
          parentTabId: tab.entityId,
          leafId: pane.leafId,
          ptyId: pane.ptyId
        })
      }
    }
  }
  return panes
}
