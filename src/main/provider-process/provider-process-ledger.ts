export type { ProviderLaunchRecord } from './provider-process-inventory'
import { randomUUID } from 'node:crypto'
import { hasUnambiguousStartTime } from '../pty-descendant-termination'
import { join } from 'node:path'
import { readProcessStartTimeMs } from '../runtime/agent-session-process-identity-probe'
import { ProviderCleanupBudget } from './provider-process-exit-deadline'
import { readPosixProcessRow } from './provider-process-row-read'
import {
  captureProviderGroup,
  stopRecordedProviderGroup,
  type ProviderGroupMember
} from './provider-process-group'
import {
  discoverProviderLaunches,
  providerLedgerDirectory,
  providerLedgerStates,
  readProviderLedgerEntry,
  publishProviderEntry,
  runProviderRecovery,
  installProviderLedgerEntry,
  serializeProviderEntry,
  writerVerdict,
  deriveObligation,
  UNKNOWN_RETENTION_MS,
  type ProviderResource,
  type ProviderLaunchRecord,
  type ProviderLedgerState
} from './provider-process-inventory'

function reapEntry(state: ProviderLedgerState, budget: ProviderCleanupBudget): Promise<void> {
  return serializeProviderEntry(state, async () => {
    let entry = state.entry
    let mutable = true
    if (!state.local) {
      const current = await readProviderLedgerEntry(
        join(entry.directory, `${entry.token}.json`),
        budget
      ).catch(() => null)
      if (!budget.active) {
        return
      }
      mutable = current?.token === entry.token && current.createdAt === entry.createdAt
      if (current && mutable) {
        current.groupRetired ||= entry.groupRetired
        current.unknownSince = entry.unknownSince
        state.entry = entry = current
      }
    }
    const owner = await readPosixProcessRow(entry.owner.pid, process.platform, budget)
    const liveOwner =
      owner &&
      owner !== 'unverifiable' &&
      !owner.zombie &&
      owner.startedAt === entry.owner.startedAt
    if (liveOwner) {
      delete entry.unknownSince?.group
    }
    if (!entry.groupRetired && !liveOwner) {
      const owns = async (): Promise<boolean> => {
        if (!budget.active || entry.groupRetired) {
          return false
        }
        const current = await readProviderLedgerEntry(
          join(entry.directory, `${entry.token}.json`),
          budget
        ).catch(() => null)
        const fresh = await readPosixProcessRow(entry.owner.pid, process.platform, budget)
        return (
          budget.active &&
          current?.token === entry.token &&
          current.createdAt === entry.createdAt &&
          !current.groupRetired &&
          fresh !== 'unverifiable' &&
          (!fresh || fresh.zombie === true || fresh.startedAt !== entry.owner.startedAt)
        )
      }
      const verdict =
        owner === 'unverifiable'
          ? 'unverifiable'
          : await stopRecordedProviderGroup(entry.pgid, entry.members, owns, false, budget)
      if (!budget.active) {
        return
      }
      deriveObligation(
        state,
        'group',
        verdict === 'exited' ? 'exited' : verdict === 'live' ? 'live' : 'unknown'
      )
    }
    if (entry.resource) {
      const verdict = await writerVerdict(entry.members, budget)
      if (!budget.active) {
        return
      }
      deriveObligation(state, 'resource', verdict)
    }
    if (!liveOwner && mutable && budget.active) {
      await publishProviderEntry(state, budget)
    }
  })
}

/** Discovery hands over residual evidence; completion of a sweep never certifies a home empty. */
export async function recoverProviderLaunches(rootPid?: number): Promise<void> {
  if (process.platform === 'win32') {
    return
  }
  if (!(await discoverProviderLaunches(new ProviderCleanupBudget(Date.now() + 2_000)))) {
    return
  }
  const pending = providerLedgerStates().filter(
    (state) => rootPid === undefined || state.entry.pgid === rootPid
  )
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(4, pending.length) }, async () => {
      while (next < pending.length) {
        const state = pending[next++]
        if (!state) {
          break
        }
        const budget = new ProviderCleanupBudget()
        await runProviderRecovery(state, budget, () => reapEntry(state, budget))
      }
    })
  )
}

export async function verifyRecoveredProviderResources(
  key: string,
  budget: ProviderCleanupBudget
): Promise<boolean> {
  if (process.platform === 'win32') {
    return true
  }
  let verified = true
  await Promise.all(
    providerLedgerStates()
      .filter((state) => state.entry.resource?.key === key)
      .map(async (state) => {
        await runProviderRecovery(state, budget, () => reapEntry(state, budget))
        if (state.entry.resource) {
          verified = false
        }
      })
  )
  return budget.active && verified
}

/** A retained old root number is not proof that a new lease came from direct launch. */
export async function hasRecordedProviderLaunch(
  pgid: number,
  processStartTimeMs?: number
): Promise<boolean> {
  const budget = new ProviderCleanupBudget(Date.now() + 2_000)
  if (!(await discoverProviderLaunches(budget))) {
    return false
  }
  const row = await readPosixProcessRow(pgid, process.platform, budget)
  if (
    !row ||
    row === 'unverifiable' ||
    row.zombie ||
    processStartTimeMs === undefined ||
    (await readProcessStartTimeMs(pgid)) !== processStartTimeMs
  ) {
    return false
  }
  return (
    budget.active &&
    providerLedgerStates().some(
      ({ entry }) =>
        entry.pgid === pgid &&
        entry.members.some((member) => member.pid === pgid && member.startedAt === row.startedAt)
    )
  )
}

/** Recording is advisory: a filesystem failure cannot refuse an agent launch. */
export function recordProviderLaunch(
  pgid: number,
  resource?: ProviderResource
): ProviderLaunchRecord {
  const token = randomUUID()
  let members: ProviderGroupMember[] = []
  let state: ProviderLedgerState | undefined
  let retired = false
  let released = false
  let unknownSince: number | undefined
  let tail = Promise.resolve()
  const uncaptured: Pick<ProviderLedgerState, 'tail' | 'flight'> = { tail: Promise.resolve() }
  const enqueue = (action: () => Promise<void>): Promise<void> => {
    tail = tail
      .then(action)
      .catch((error: unknown) =>
        console.warn('[provider-process] ownership recording failed', error)
      )
    return tail
  }
  const capture = (budget = new ProviderCleanupBudget(Date.now() + 2_000)): Promise<void> =>
    enqueue(async () => {
      if (retired || !budget.active) {
        return
      }
      const observed = await captureProviderGroup(pgid, true, budget)
      if (retired || !budget.active) {
        return
      }
      const root = members.find((member) => member.pid === pgid)
      if (root && !observed.some((row) => row.pid === pgid && row.startedAt === root.startedAt)) {
        return
      }
      for (const row of observed) {
        if (!members.some((old) => old.pid === row.pid && old.startedAt === row.startedAt)) {
          members.push(row)
        }
      }
      if (!members.length) {
        return
      }
      const boundary = Date.now()
      const owner = await readPosixProcessRow(process.pid, process.platform, budget)
      if (
        !owner ||
        owner === 'unverifiable' ||
        owner.zombie ||
        (owner.startResolution === 'second' && !hasUnambiguousStartTime(owner.startedAt, boundary))
      ) {
        return
      }
      state ??= installProviderLedgerEntry(
        {
          version: 1,
          origin: 'direct',
          token,
          directory: providerLedgerDirectory(),
          createdAt: Date.now(),
          pgid,
          owner,
          members,
          ...(resource && !released ? { resource } : {})
        },
        true
      )
      const current = state
      await serializeProviderEntry(current, async () => {
        if (retired || current.entry.groupRetired) {
          return
        }
        current.entry.members = members
        await publishProviderEntry(current, budget)
      })
    })
  void capture()
  return {
    capture,
    async verifyResource(budget) {
      const verdict = await writerVerdict(members, budget)
      if (!budget.active) {
        return false
      }
      if (state && resource) {
        const current = state
        await serializeProviderEntry(current, async () => {
          if (!budget.active) {
            return
          }
          deriveObligation(current, 'resource', verdict)
          await publishProviderEntry(current, budget)
        })
        released = !current.entry.resource
        return released
      }
      if (verdict === 'live') {
        unknownSince = undefined
      }
      if (verdict === 'unknown') {
        unknownSince ??= Date.now()
        if (Date.now() - unknownSince < UNKNOWN_RETENTION_MS) {
          return false
        }
        console.warn('[provider-process] abandoning unpersisted unknown resource obligation', token)
        return true
      }
      return verdict === 'exited'
    },
    cleanup: (budget, action) => runProviderRecovery(state ?? uncaptured, budget, action),
    members: () => members,
    retire: () => {
      retired = true
      return enqueue(async () => {
        if (state) {
          const current = state
          await serializeProviderEntry(current, async () => {
            current.entry.groupRetired = true
            await publishProviderEntry(current, new ProviderCleanupBudget())
          })
        }
      })
    }
  }
}
