// Why: time-decaying scores would make rows jump on every bump; coalesce a burst into one re-sort.
export const SORT_SETTLE_MS = 3_000

export type SortSettleState = {
  /** Why from the last bump (not the previous write): a row change that skipped its bump (stale-host purge) must not re-sort on its own. */
  liveCountAtLastBump: number
  /** When the pending burst settles; null when nothing is pending. */
  deadline: number | null
}

export type SortSettleEvent =
  | {
      kind: 'write'
      epochChanged: boolean
      /** Non-archived row count, sampled only when the epoch or the rows changed. */
      liveCount: number | null
      /** The write already lands settled: settling itself, or a store reset. */
      settled: boolean
      /** Manual (direct manipulation) and a mode switch never wait out the window. */
      immediate: boolean
    }
  | { kind: 'deadline' }

export type SortSettleStep = { state: SortSettleState; settle: boolean }

export const INITIAL_SORT_SETTLE_STATE: SortSettleState = { liveCountAtLastBump: 0, deadline: null }

export function reduceSortSettle(
  state: SortSettleState,
  event: SortSettleEvent,
  now: number
): SortSettleStep {
  if (event.kind === 'deadline') {
    return { state: { ...state, deadline: null }, settle: state.deadline !== null }
  }
  const { epochChanged, liveCount } = event
  const structuralChange = liveCount !== null && liveCount !== state.liveCountAtLastBump
  const liveCountAtLastBump =
    epochChanged && liveCount !== null ? liveCount : state.liveCountAtLastBump
  if (event.settled) {
    return { state: { liveCountAtLastBump, deadline: null }, settle: false }
  }
  // Why: adds and removes never wait out the window either.
  if (structuralChange || event.immediate) {
    return { state: { liveCountAtLastBump, deadline: null }, settle: true }
  }
  const deadline = epochChanged ? now + SORT_SETTLE_MS : state.deadline
  return { state: { liveCountAtLastBump, deadline }, settle: false }
}
