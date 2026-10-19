/**
 * A window spawn's pending visible consumer, held from the request until the
 * pane installs its own consumer report and settles the token. Records belong
 * to one renderer document and die with it; a handle acts only while its own
 * record is still registered, so a late request cannot touch a successor's.
 */
import type { PtySpawnOptions } from '../../../providers/pty-provider-contract'

type SpawnConsumerRecord = { readonly key: string; readonly doc: string; ptyId: string | null }

export type SpawnConsumerClaim = {
  bind: (ptyId: string) => void
  release: () => void
}

const recordsByKey = new Map<string, SpawnConsumerRecord>()
const claimCountByPty = new Map<string, number>()
// Why null-init + wrapper fn: see debug.ts — rolldown const-folds `export let fn = noop` bridges (STA-5661).
let claimChangeImpl: ((ids: readonly string[], mutate: () => void) => void) | null = null

/** Wired by the IPC session so claim changes re-derive drain, drop and pacing state. */
export function setSpawnConsumerClaimChangeHandler(
  fn: ((ids: readonly string[], mutate: () => void) => void) | null
): void {
  claimChangeImpl = fn
}

function changeClaims(ids: readonly string[], mutate: () => void): void {
  if (claimChangeImpl) {
    claimChangeImpl(ids, mutate)
  } else {
    mutate()
  }
}

function adjustCount(ptyId: string | null, delta: number): void {
  if (ptyId === null) {
    return
  }
  const next = (claimCountByPty.get(ptyId) ?? 0) + delta
  if (next > 0) {
    claimCountByPty.set(ptyId, next)
  } else {
    claimCountByPty.delete(ptyId)
  }
}

function isLive(record: SpawnConsumerRecord): boolean {
  return recordsByKey.get(record.key) === record
}

function deleteRecord(record: SpawnConsumerRecord): void {
  recordsByKey.delete(record.key)
  adjustCount(record.ptyId, -1)
}

export function openSpawnConsumerClaim(doc: string, token: number): SpawnConsumerClaim {
  const record: SpawnConsumerRecord = { key: `${doc}:${token}`, doc, ptyId: null }
  const replaced = recordsByKey.get(record.key)
  if (replaced) {
    deleteRecord(replaced)
  }
  recordsByKey.set(record.key, record)
  return {
    bind: (ptyId) => {
      if (!isLive(record) || record.ptyId === ptyId) {
        return
      }
      const previous = record.ptyId
      changeClaims(previous === null ? [ptyId] : [previous, ptyId], () => {
        adjustCount(previous, -1)
        record.ptyId = ptyId
        adjustCount(ptyId, 1)
      })
    },
    release: () => {
      if (!isLive(record)) {
        return
      }
      changeClaims(record.ptyId === null ? [] : [record.ptyId], () => deleteRecord(record))
    }
  }
}

/** Daemon ids are known up front; a local id is bound as it is allocated, before activation emits. */
export function withSpawnConsumerClaimBinding(
  spawnOptions: PtySpawnOptions,
  claim: SpawnConsumerClaim | null | undefined
): PtySpawnOptions {
  if (!claim) {
    return spawnOptions
  }
  if (spawnOptions.sessionId) {
    claim.bind(spawnOptions.sessionId)
  }
  const committed = spawnOptions.onPtySpawnCommitted
  return {
    ...spawnOptions,
    onPtySpawnCommitted: (ptyId) => {
      if (ptyId) {
        claim.bind(ptyId)
      }
      committed?.(ptyId)
    }
  }
}

export function settleSpawnConsumerClaim(doc: string, token: number): void {
  const record = recordsByKey.get(`${doc}:${token}`)
  if (record) {
    changeClaims(record.ptyId === null ? [] : [record.ptyId], () => deleteRecord(record))
  }
}

/** Deletes every record the retired document opened; the caller re-derives the affected ids. */
export function deleteSpawnConsumerClaimsForDocument(doc: string): void {
  for (const record of [...recordsByKey.values()]) {
    if (record.doc === doc) {
      deleteRecord(record)
    }
  }
}

/** PTY teardown keeps the request's record so a replacement spawn can bind it again. */
export function unbindSpawnConsumerClaimsForPty(ptyId: string): void {
  for (const record of recordsByKey.values()) {
    if (record.ptyId === ptyId) {
      record.ptyId = null
    }
  }
  claimCountByPty.delete(ptyId)
}

export function hasSpawnConsumerClaim(ptyId: string): boolean {
  return claimCountByPty.has(ptyId)
}

export function getSpawnConsumerClaimPtyIds(): string[] {
  return [...claimCountByPty.keys()]
}

export function _resetSpawnConsumerClaimsForTest(): void {
  recordsByKey.clear()
  claimCountByPty.clear()
}
