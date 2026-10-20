// Main's start of a pane's terminal (layout-owner build): live state laid over the published layout
// like a pane's live title, never saved. A start ends in a binding, which clears it, or a failure,
// which stays until main's next start into the pane. A pane may still be bound to the terminal it
// had (a restart into it): a status says that binding is not live, and lasts only while the
// binding it was first published with stands, so any later bind (a window's own spawn, an adopt)
// ends it. Keys are never reused.

import type {
  PaneStartStatus,
  PublishedWorkspaceLayout
} from '../../shared/workspace-layout/workspace-layout-published'

export type PaneStartFact = { status: PaneStartStatus; reason?: string }

/** A pane's start status (layout-owner build), given the pane's current binding (`bindingOf`). */
export type PaneStartFactOf = (paneKey: string, binding: string) => PaneStartFact | null

/** A pane's terminal binding as published: its terminal and that terminal's bind generation. */
export function bindingOf(pane: { ptyId?: string; ptyGeneration?: number }): string {
  return `${pane.ptyId ?? ''}#${pane.ptyGeneration ?? ''}`
}

export class PaneStartStatuses {
  private readonly byPaneKey = new Map<string, { fact: PaneStartFact; binding?: string }>()

  constructor(private readonly changed: () => void) {}

  set(paneKey: string, fact: PaneStartFact): void {
    this.byPaneKey.set(paneKey, { fact })
    this.changed()
  }

  clear(paneKey: string): void {
    if (this.byPaneKey.delete(paneKey)) {
      this.changed()
    }
  }

  /** The status while the pane keeps the binding it was first published with; a new bind ends it. */
  get(paneKey: string, binding: string): PaneStartFact | null {
    const entry = this.byPaneKey.get(paneKey)
    if (!entry) {
      return null
    }
    entry.binding ??= binding
    if (entry.binding !== binding) {
      this.byPaneKey.delete(paneKey)
      return null
    }
    return entry.fact
  }
}

/** Each pane's start status, in tab and pane order; null for a pane with none. */
export function paneStartFactsOf(
  layout: PublishedWorkspaceLayout,
  { paneStartFact: statusOf }: { paneStartFact?: PaneStartFactOf }
): (PaneStartFact | null)[] {
  if (!statusOf) {
    return []
  }
  return layout.tabs.flatMap((tab) =>
    (tab.terminal?.panes ?? []).map((pane) =>
      statusOf(`${tab.entityId}:${pane.leafId}`, bindingOf(pane))
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
