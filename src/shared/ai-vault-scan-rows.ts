import type { AiVaultSession } from './ai-vault-types'

/** Current membership only; never a completed list or a freshness validator. */
export type AiVaultScanRows = {
  scanId: string
  revision: number
  sessions: readonly AiVaultSession[]
}

export type AiVaultRowDelta = {
  upserts: AiVaultSession[]
  removed: string[]
}

export type AiVaultRowsEvent = AiVaultRowDelta & {
  requestToken: string
  scanId: string
  sequence: number
  reset: boolean
}

export type AiVaultRowObserver = (read: () => readonly AiVaultSession[]) => void
