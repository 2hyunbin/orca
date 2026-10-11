import type { TerminalLayoutContext } from './terminal-layout-context'
import type { ApplyLayoutResult, PtyLayoutState, PtyLayoutTarget } from '../../orca-runtime-core'

export function pickMostRecentActor(
  inner: Map<string, { clientId: string; lastActedAt: number }>
): { clientId: string; lastActedAt: number } | null {
  let best: { clientId: string; lastActedAt: number } | null = null
  for (const sub of inner.values()) {
    if (best === null || sub.lastActedAt > best.lastActedAt) {
      best = sub
    }
  }
  return best
}

export function pickEarliestRestoreTarget(
  inner: Map<
    string,
    { subscribedAt: number; previousCols: number | null; previousRows: number | null }
  >
): { previousCols: number; previousRows: number } | null {
  let best: { subscribedAt: number; previousCols: number; previousRows: number } | null = null
  for (const sub of inner.values()) {
    if (sub.previousCols == null || sub.previousRows == null) {
      continue
    }
    if (best === null || sub.subscribedAt < best.subscribedAt) {
      best = {
        subscribedAt: sub.subscribedAt,
        previousCols: sub.previousCols,
        previousRows: sub.previousRows
      }
    }
  }
  return best ? { previousCols: best.previousCols, previousRows: best.previousRows } : null
}

export function getLayout(ctx: TerminalLayoutContext, ptyId: string): PtyLayoutState | null {
  return ctx.state.layouts.get(ptyId) ?? null
}

export function isFreshSubscribe(ctx: TerminalLayoutContext, ptyId: string): boolean {
  return ctx.state.freshSubscribeGuard.has(ptyId)
}

export function resolveDesktopRestoreTarget(
  ctx: TerminalLayoutContext,
  ptyId: string
): { cols: number; rows: number } {
  // 1. Earliest-by-subscribedAt subscriber with non-null baseline.
  const inner = ctx.state.mobileSubscribers.get(ptyId)
  if (inner) {
    const earliest = ctx.commands.pickEarliestRestoreTarget(inner)
    if (earliest) {
      return { cols: earliest.previousCols, rows: earliest.previousRows }
    }
  }
  // 2. Most-recent desktop renderer geometry report.
  const renderer = ctx.state.lastRendererSizes.get(ptyId)
  if (renderer) {
    return { cols: renderer.cols, rows: renderer.rows }
  }
  // 3. Current PTY size.
  const size = ctx.host.getTerminalSize(ptyId)
  if (size) {
    return { cols: size.cols, rows: size.rows }
  }
  // 4. Hard default.
  return { cols: 80, rows: 24 }
}

export function coalescesWith(prev: PtyLayoutTarget, next: PtyLayoutTarget): boolean {
  if (prev.kind !== next.kind) {
    return false
  }
  if (prev.kind === 'phone' && next.kind === 'phone') {
    return prev.ownerClientId === next.ownerClientId
  }
  if (prev.kind === 'remote-desktop' && next.kind === 'remote-desktop') {
    // Why: each owner's claim promise gates its following input. Sharing a
    // waiter across owners could release A's input only after B's grid lands.
    return prev.ownerSubscriptionKey === next.ownerSubscriptionKey
  }
  return true
}

export function enqueueLayout(
  ctx: TerminalLayoutContext,
  ptyId: string,
  target: PtyLayoutTarget
): Promise<ApplyLayoutResult> {
  // Why: PTY-exit short-circuit. Fresh-subscribe gate lets the very first
  // transition through even though `layouts` has no entry yet.
  if (!ctx.state.layouts.has(ptyId) && !ctx.commands.isFreshSubscribe(ptyId)) {
    return Promise.resolve({ ok: false, reason: 'pty-exited' })
  }

  let entry = ctx.state.layoutQueues.get(ptyId)
  if (!entry) {
    entry = { running: null, pending: [] }
    ctx.state.layoutQueues.set(ptyId, entry)
  }
  const queue = entry

  return new Promise<ApplyLayoutResult>((resolve) => {
    if (!queue.running) {
      queue.running = ctx.commands.runLayoutSlot(ptyId, target, [resolve])
      return
    }
    const tail = queue.pending.at(-1)
    if (tail && ctx.commands.coalescesWith(tail.target, target)) {
      tail.target = target
      tail.waiters.push(resolve)
      return
    }
    queue.pending.push({ target, waiters: [resolve] })
  })
}

export async function runLayoutSlot(
  ctx: TerminalLayoutContext,
  ptyId: string,
  target: PtyLayoutTarget,
  waiters: ((r: ApplyLayoutResult) => void)[]
): Promise<ApplyLayoutResult> {
  let result: ApplyLayoutResult
  try {
    result = await ctx.commands.applyLayout(ptyId, target)
  } catch (err) {
    // Why: defensive — applyLayout itself catches resize errors, but a
    // throw from one of the synchronous map writes (e.g. notifier hook)
    // must not jam the queue forever.
    console.error('[layout] applyLayout threw', { ptyId, err })
    result = { ok: false, reason: 'resize-failed' }
  }
  for (const w of waiters) {
    w(result)
  }

  const queue = ctx.state.layoutQueues.get(ptyId)
  if (!queue) {
    return result
  }
  const next = queue.pending.shift()
  if (next) {
    queue.running = ctx.commands.runLayoutSlot(ptyId, next.target, next.waiters)
  } else {
    queue.running = null
    // Why: drop the entry once empty so the map doesn't grow without bound
    // across short-lived PTYs.
    ctx.state.layoutQueues.delete(ptyId)
  }
  return result
}
