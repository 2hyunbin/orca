import { AsyncLocalStorage } from 'node:async_hooks'

export type StickySlotSample = {
  holdMs: number
  queueWaitMs: number
  sqlMs: number
  statements: number
  // Transaction statements only: a pooled autocommit query never exposes its connection.
  statementMsByConnection: ReadonlyMap<number, readonly number[]>
}

// SQL run while one request holds the sticky slot. Closed at release, so work the
// request left running cannot be charged to it afterwards.
export class StickySlotStatements {
  private closed = false
  private sqlMs = 0
  private statements = 0
  private readonly statementMsByConnection = new Map<number, number[]>()

  note(durationMs: number, connectionId: number | undefined): void {
    if (this.closed) return
    this.statements++
    this.sqlMs += durationMs
    if (connectionId === undefined) return
    const samples = this.statementMsByConnection.get(connectionId)
    if (samples) samples.push(durationMs)
    else this.statementMsByConnection.set(connectionId, [durationMs])
  }

  close(): Pick<StickySlotSample, 'sqlMs' | 'statements' | 'statementMsByConnection'> {
    this.closed = true
    return {
      sqlMs: this.sqlMs,
      statements: this.statements,
      statementMsByConnection: this.statementMsByConnection
    }
  }
}

const activeStickySlot = new AsyncLocalStorage<StickySlotStatements>()

export function runInStickySlot<T>(
  statements: StickySlotStatements,
  work: () => Promise<T>
): Promise<T> {
  return activeStickySlot.run(statements, work)
}

export function noteStickySlotStatement(
  durationMs: number,
  connectionId: number | undefined
): void {
  activeStickySlot.getStore()?.note(durationMs, connectionId)
}
