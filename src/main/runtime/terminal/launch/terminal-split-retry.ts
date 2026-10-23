import type { TerminalPaneSplitSource } from '../../../../shared/feature-education-telemetry'
import { TerminalSplitOutcomeError } from '../../../../shared/terminal-split-outcome'
import { SPLIT_PANE_WAIT_TIMEOUT_MESSAGE } from './terminal-split-wait-timeout'

/** What main asked the window to split; replayed unchanged so a retry cannot change the command. */
export type RendererSplitRequest = {
  tabId: string
  paneRuntimeId: number
  direction: 'horizontal' | 'vertical'
  command?: string
  worktreeId: string
  sourceLeafId: string
  telemetrySource?: TerminalPaneSplitSource
}

type RendererSplitEntry = {
  request: RendererSplitRequest
  recordedAt: number
  /** Main's graph listed the pane at least once; its absence now means it was closed. */
  seen: boolean
}

const MAX_RENDERER_SPLITS = 128
const RENDERER_SPLIT_TTL_MS = 30 * 60_000

/** Window-made splits keyed by the new pane's leaf id, so a retry joins the split instead of repeating it. */
export class RendererSplitLedger {
  private readonly entries = new Map<string, RendererSplitEntry>()

  constructor(private readonly now: () => number = Date.now) {}

  record(leafId: string, request: RendererSplitRequest): void {
    this.prune()
    this.entries.set(leafId, { request, recordedAt: this.now(), seen: false })
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= MAX_RENDERER_SPLITS) {
        break
      }
      this.entries.delete(oldest)
    }
  }

  get(leafId: string): { request: RendererSplitRequest; seen: boolean } | null {
    this.prune()
    return this.entries.get(leafId) ?? null
  }

  /** Marks listed panes seen; returns whether any split is still waiting to be seen. */
  observe(isListed: (tabId: string, leafId: string) => boolean): boolean {
    this.prune()
    let unseen = false
    for (const [leafId, entry] of this.entries) {
      if (!entry.seen && isListed(entry.request.tabId, leafId)) {
        entry.seen = true
      }
      unseen ||= !entry.seen
    }
    return unseen
  }

  private prune(): void {
    const cutoff = this.now() - RENDERER_SPLIT_TTL_MS
    for (const [leafId, entry] of this.entries) {
      if (entry.recordedAt < cutoff) {
        this.entries.delete(leafId)
      }
    }
  }
}

const LIST_BEFORE_SPLITTING =
  'Before splitting again, check `orca terminal list --json` for a pane with this leafId: its command may already be running.'

export function splitPanePendingError(tabId: string, leafId: string): TerminalSplitOutcomeError {
  return new TerminalSplitOutcomeError(
    `${SPLIT_PANE_WAIT_TIMEOUT_MESSAGE}: pane ${leafId} in tab ${tabId} may still open and run its command.`,
    {
      splitId: leafId,
      tabId,
      splitMayStillComplete: true,
      nextSteps: [
        `Do not split again. With an orca CLI that has --retry-split, re-run the same command with --retry-split ${leafId} to wait for this pane and get its handle.`,
        LIST_BEFORE_SPLITTING
      ]
    }
  )
}

export function splitRetryUnknownError(tabId: string, leafId: string): TerminalSplitOutcomeError {
  return new TerminalSplitOutcomeError(
    `This Orca host has no record of split ${leafId} from this terminal; it was not split again.`,
    { splitId: leafId, tabId, splitMayStillComplete: false, nextSteps: [LIST_BEFORE_SPLITTING] }
  )
}

export function splitPaneClosedError(tabId: string, leafId: string): TerminalSplitOutcomeError {
  return new TerminalSplitOutcomeError(
    `Split pane ${leafId} in tab ${tabId} opened and was then closed.`,
    { splitId: leafId, tabId, splitMayStillComplete: false, nextSteps: [] }
  )
}
