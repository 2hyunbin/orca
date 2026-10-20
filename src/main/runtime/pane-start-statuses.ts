// Main's start of a pane's terminal, while the pane has none (layout-owner build): live state laid
// over the published layout like a pane's live title, never saved. A start ends in a binding,
// which clears it, or a failure, which the pane keeps until it binds or closes.

import type {
  PaneStartStatus,
  PublishedWorkspaceLayout
} from '../../shared/workspace-layout/workspace-layout-published'

export type PaneStartFact = { status: PaneStartStatus; reason?: string }

export class PaneStartStatuses {
  private readonly byPaneKey = new Map<string, PaneStartFact>()

  constructor(private readonly changed: () => void) {}

  set(paneKey: string, fact: PaneStartFact): void {
    this.byPaneKey.set(paneKey, fact)
    this.changed()
  }

  clear(paneKey: string): void {
    if (this.byPaneKey.delete(paneKey)) {
      this.changed()
    }
  }

  get(paneKey: string): PaneStartFact | null {
    return this.byPaneKey.get(paneKey) ?? null
  }
}

/** Each pane's start status, in tab and pane order; null for a bound pane or one with none. */
export function paneStartFactsOf(
  layout: PublishedWorkspaceLayout,
  statusOf: (paneKey: string) => PaneStartFact | null
): (PaneStartFact | null)[] {
  return layout.tabs.flatMap((tab) =>
    (tab.terminal?.panes ?? []).map((pane) =>
      pane.ptyId ? null : statusOf(`${tab.entityId}:${pane.leafId}`)
    )
  )
}

/** `facts` from paneStartFactsOf laid over the layout; the same layout when all are null. */
export function withPaneStartFacts(
  layout: PublishedWorkspaceLayout,
  facts: (PaneStartFact | null)[]
): PublishedWorkspaceLayout {
  if (facts.every((fact) => fact === null)) {
    return layout
  }
  let index = 0
  return {
    ...layout,
    tabs: layout.tabs.map((tab) =>
      tab.terminal
        ? {
            ...tab,
            terminal: {
              ...tab.terminal,
              panes: tab.terminal.panes.map((pane) => {
                const fact = facts[index++]
                return fact
                  ? {
                      ...pane,
                      status: fact.status,
                      ...(fact.reason ? { statusReason: fact.reason } : {})
                    }
                  : pane
              })
            }
          }
        : tab
    )
  }
}
