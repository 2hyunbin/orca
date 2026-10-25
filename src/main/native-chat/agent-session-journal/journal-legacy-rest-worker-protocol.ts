import type { JournalRestFacts } from './journal-row-table'

export type LegacyRestSource = {
  epoch: string
  pair: readonly [string | null, number | null]
  known: boolean
  tip: number
  guard: string
}
export type LegacyRestRequest = {
  id: number
  generation: number
  sessionId: string
  source?: LegacyRestSource
  mode: 'replay' | 'cleanup' | 'discover'
}
export type LegacyRestResponse = {
  id: number
  generation: number
  sessionId: string
  guard: string
  status: 'progress' | 'paused' | 'drift' | 'complete' | 'clean' | 'found' | 'exhausted' | 'failed'
  cursor: number
  pending: boolean
  occupiedMs: number
  fact?: JournalRestFacts['openTurn']
  candidate?: string
  error?: string
}
export type LegacyRestExecutor = {
  grant(request: Omit<LegacyRestRequest, 'id'>, canWork: () => boolean): Promise<LegacyRestResponse>
  retire(): Promise<void>
  close(): Promise<void>
}

export function legacyRestPermitted(control: Int32Array, generation: number): boolean {
  return Atomics.load(control, 0) === 0 && Atomics.load(control, 1) === generation
}
