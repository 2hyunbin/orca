// Main's start of a pane's terminal resumed its agent, or could not (layout-owner build): live state
// laid over the published layout like a start status, never saved. It names the terminal that start
// made, shows once the pane binds that terminal, and ends with that binding.

import type { PaneResumeOutcome } from '../../shared/workspace-layout/workspace-layout-published'
import { bindingOf } from './pane-start-statuses'

type PaneBinding = { ptyId?: string; ptyGeneration?: number }

/** A pane's resume outcome (layout-owner build), given the pane as published. */
export type PaneResumeOutcomeOf = (paneKey: string, pane: PaneBinding) => PaneResumeOutcome | null

export class PaneResumeOutcomes {
  private readonly byPaneKey = new Map<
    string,
    { ptyId: string; outcome: PaneResumeOutcome; binding?: string }
  >()

  constructor(private readonly changed: () => void) {}

  set(paneKey: string, ptyId: string, outcome: PaneResumeOutcome): void {
    this.byPaneKey.set(paneKey, { ptyId, outcome })
    this.changed()
  }

  /** The outcome while the pane is bound to the terminal it names; a later bind ends it. */
  get(paneKey: string, pane: PaneBinding): PaneResumeOutcome | null {
    const entry = this.byPaneKey.get(paneKey)
    if (!entry) {
      return null
    }
    if (entry.binding === undefined) {
      // Why not ended: the start's bind write can land after its outcome.
      if (pane.ptyId !== entry.ptyId) {
        return null
      }
      entry.binding = bindingOf(pane)
    }
    if (entry.binding !== bindingOf(pane)) {
      this.byPaneKey.delete(paneKey)
      return null
    }
    return entry.outcome
  }
}
