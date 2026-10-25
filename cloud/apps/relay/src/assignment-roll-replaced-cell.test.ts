import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { RelayAssignmentStore, RelayHomeCellUnavailableError } from './assignment-store.js'
import {
  encodeMembership,
  type CellAdmissionMembership,
  type CellAdmissionState
} from './cell-admission-selector.js'
import type { RelayCellConfig } from './config.js'
import { openInMemoryRelayDatabase, type RelayDatabase } from './database.js'

// Production 2026-10-24, production-gce-c15: a same-cap roll isolates the cell, drains it,
// then replaces its one VM. A host that was offline through the drain still names the cell,
// and redialled in the ~45 s before the new process was ready.
const HEARTBEAT_TTL_MS = 45_000
const START_MS = 100
const IDENTITY = { userId: 'user-a', relayHostId: 'host000000000001' }
const OLD_INCARNATION = '11111111-1111-4111-8111-111111111111'
const NEW_INCARNATION = '22222222-2222-4222-8222-222222222222'
const OTHER_INCARNATION = '33333333-3333-4333-8333-333333333333'
// Capped is what makes the dead-cell path demand a fence (relay_home_cell_unavailable).
const CAPPED = {
  capacityRequests: 1_000,
  connectionHardCap: 600,
  connectionUnobservedBound: 50
} as const
const SOURCE: RelayCellConfig = {
  id: 'us-c1',
  url: 'https://us-c1.example.com',
  region: 'us-central1',
  ...CAPPED
}
const TARGET: RelayCellConfig = {
  id: 'us-c2',
  url: 'https://us-c2.example.com',
  region: 'us-central1',
  ...CAPPED
}
const CELLS = [SOURCE, TARGET]

const FENCE_ATTEMPT_ID = '44444444-4444-4444-8444-444444444444'
const FENCE_INVOCATION_ID = '55555555-5555-4555-8555-555555555555'
const FENCE_REQUEST_REASON = 'orca-relay-fence/44444444-4444-4444-8444-444444444444'
const FENCE_EVIDENCE = {
  attemptId: FENCE_ATTEMPT_ID,
  environment: 'production' as const,
  cellId: SOURCE.id,
  cellIncarnation: OLD_INCARNATION,
  migName: 'orca-relay-c1',
  instanceGroup: 'https://compute.example/instanceGroups/orca-relay-c1',
  generationIdentity: 'https://compute.example/instanceTemplates/orca-relay-c1-abc',
  fenceCommit: 'a'.repeat(40),
  planSha256: 'b'.repeat(64),
  planObjectName:
    'terraform/state/relay-fence-plans/production/44444444-4444-4444-8444-444444444444.tfplan',
  planObjectGeneration: '123456789',
  varFileSha256: 'c'.repeat(64),
  terraformStateLineage: '66666666-6666-4666-8666-666666666666',
  terraformStateSerial: 7,
  terraformStateObjectGeneration: '987654321',
  terraformStateObjectSha256: 'd'.repeat(64),
  requestReason: FENCE_REQUEST_REASON
}

const databases: RelayDatabase[] = []

afterEach(async () => {
  for (const database of databases.splice(0)) await database.close()
})

type Beat = {
  incarnation?: string
  startedAt?: number
  ready?: boolean
  totalConnections?: number
}

async function setup() {
  const database = await openInMemoryRelayDatabase()
  databases.push(database)
  let now = START_MS
  const store = new RelayAssignmentStore(database, () => now, {
    requireLiveCells: true,
    heartbeatTtlMs: HEARTBEAT_TTL_MS
  })
  await store.reconcileCells(CELLS, true)
  const heartbeat = async (cell: RelayCellConfig, beat: Beat = {}): Promise<void> => {
    const total = beat.totalConnections ?? 0
    await store.recordCellHeartbeat({
      cellId: cell.id,
      cellUrl: cell.url,
      cellIncarnation:
        beat.incarnation ?? (cell === SOURCE ? OLD_INCARNATION : OTHER_INCARNATION),
      startedAt: beat.startedAt ?? 50,
      ready: beat.ready ?? true,
      observedRequests: 0,
      region: cell.region,
      totalConnections: total,
      inFlightConnections: 0,
      reservedConnectionUnits: 0,
      enforcedConnectionUnits: total,
      connectionHardCap: CAPPED.connectionHardCap,
      connectionUnobservedBound: CAPPED.connectionUnobservedBound
    })
  }
  for (const cell of CELLS) await heartbeat(cell)

  const applySelector = async (
    state: CellAdmissionState,
    rollIsolatedCells?: string[]
  ): Promise<void> => {
    const current = await store.inspectCellAdmissionSelector()
    const membership: CellAdmissionMembership = {
      existingOnly: state === 'existing-only' ? [SOURCE.id] : [],
      migrationOnly: state === 'migration-only' ? [SOURCE.id] : [],
      general: state === 'general' ? [SOURCE.id, TARGET.id] : [TARGET.id]
    }
    await store.applyCellAdmissionSelector({
      attemptId: `attempt-${current.selector.generation}`,
      expectedGeneration: current.selector.generation,
      ...(current.selector.generation === 0
        ? {
            expectedMembershipSha256: createHash('sha256')
              .update(encodeMembership(current.selector.membership))
              .digest('hex')
          }
        : {}),
      membership,
      ...(rollIsolatedCells ? { rollIsolatedCells } : {})
    })
  }

  // The host lands on SOURCE, which the roll then isolates at START_MS.
  const first = await store.assign(IDENTITY, 'us-central1')
  expect(first.cellId).toBe(SOURCE.id)

  const fence = async (): Promise<void> => {
    await store.prepareCellFenceAttempt(FENCE_EVIDENCE)
    await store.bindCellFencePlanGeneration(FENCE_EVIDENCE, FENCE_EVIDENCE.planObjectGeneration)
    await store.startCellFenceApply(
      FENCE_EVIDENCE,
      FENCE_INVOCATION_ID,
      `${FENCE_REQUEST_REASON}/${FENCE_INVOCATION_ID}`
    )
    await store.recordCellFenceOperation(
      FENCE_EVIDENCE,
      FENCE_INVOCATION_ID,
      `${FENCE_REQUEST_REASON}/${FENCE_INVOCATION_ID}`,
      'operation-1'
    )
    await store.attestCellFenceAttempt(FENCE_EVIDENCE, 'operation-1')
  }

  return {
    store,
    database,
    first,
    heartbeat,
    fence,
    at: async (value: number): Promise<void> => {
      now = value
      await heartbeat(TARGET)
    },
    isolateForRoll: async () => await applySelector('migration-only', [SOURCE.id]),
    park: async (state: CellAdmissionState) => await applySelector(state)
  }
}

// The old process stopped heartbeating at START_MS, so it is unheard from here.
const OLD_UNHEARD_AT = START_MS + HEARTBEAT_TTL_MS + 1_000

// Both routes that refused in production: a hinted assign (placement lane after its
// verification read finds the cell not live) and resolve, which then assigns.
async function hintedAssign(store: RelayAssignmentStore) {
  return await store.assign(IDENTITY, 'us-central1', 'us-central1', undefined, {
    hostRequested: true
  })
}

async function resolveRoute(store: RelayAssignmentStore) {
  return (await store.resolve(IDENTITY)) ?? (await store.assign(IDENTITY))
}

async function expectRefused(
  attempt: Promise<unknown>,
  cause: 'not_ready' | 'unheard'
): Promise<void> {
  const error = await attempt.catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(RelayHomeCellUnavailableError)
  expect(error).toMatchObject({ unavailableCause: cause })
}

describe.each([
  ['hinted assign', hintedAssign],
  ['resolve', resolveRoute]
] as const)('a host offline through a roll redials via %s', (_route, redial) => {
  describe('while the replacement process boots (not ready)', () => {
    it('is re-placed when that process started after the roll isolated the cell', async () => {
      const { store, first, heartbeat, at, isolateForRoll } = await setup()
      await isolateForRoll()
      await at(20_000)
      await heartbeat(SOURCE, { incarnation: NEW_INCARNATION, startedAt: 15_000, ready: false })

      const moved = await redial(store)
      expect(moved).toMatchObject({ cellId: TARGET.id })
      expect(moved.assignmentEpoch).toBeGreaterThan(first.assignmentEpoch)
    })

    it('is refused while the process is the one that was running before isolation', async () => {
      const { store, heartbeat, at, isolateForRoll } = await setup()
      await isolateForRoll()
      await at(20_000)
      await heartbeat(SOURCE, { ready: false })

      await expectRefused(redial(store), 'not_ready')
    })

    it('is refused while the new process reports holding connections', async () => {
      const { store, heartbeat, at, isolateForRoll } = await setup()
      await isolateForRoll()
      await at(20_000)
      await heartbeat(SOURCE, {
        incarnation: NEW_INCARNATION,
        startedAt: 15_000,
        ready: false,
        totalConnections: 1
      })

      await expectRefused(redial(store), 'not_ready')
    })

    it('is refused once the new process itself goes unheard', async () => {
      const { store, heartbeat, at, isolateForRoll } = await setup()
      await isolateForRoll()
      await at(20_000)
      await heartbeat(SOURCE, { incarnation: NEW_INCARNATION, startedAt: 15_000, ready: false })
      await at(20_000 + HEARTBEAT_TTL_MS + 1_000)

      await expectRefused(redial(store), 'unheard')
    })

    it('is refused on an ordinary readiness dip with no roll stamp', async () => {
      const { store, heartbeat, at } = await setup()
      await at(20_000)
      await heartbeat(SOURCE, { incarnation: NEW_INCARNATION, startedAt: 15_000, ready: false })

      await expectRefused(redial(store), 'not_ready')
    })

    it('is refused on a migration-only cell parked without a roll stamp', async () => {
      const { store, heartbeat, at, park } = await setup()
      await park('migration-only')
      await at(20_000)
      await heartbeat(SOURCE, { incarnation: NEW_INCARNATION, startedAt: 15_000, ready: false })

      await expectRefused(redial(store), 'not_ready')
    })
  })

  describe('between the old process going unheard and the new one heartbeating', () => {
    it('is refused without a committed fence', async () => {
      const { store, at, isolateForRoll } = await setup()
      await isolateForRoll()
      await at(OLD_UNHEARD_AT)

      await expectRefused(redial(store), 'unheard')
    })

    it('is re-placed with a committed fence for the old incarnation', async () => {
      const { store, first, at, fence, isolateForRoll } = await setup()
      await isolateForRoll()
      await at(OLD_UNHEARD_AT)
      await fence()

      const moved = await redial(store)
      expect(moved).toMatchObject({ cellId: TARGET.id })
      expect(moved.assignmentEpoch).toBeGreaterThan(first.assignmentEpoch)
    })
  })
})

describe('a committed fence on a roll-isolated cell', () => {
  async function fencedRollIsolated() {
    const harness = await setup()
    await harness.isolateForRoll()
    await harness.at(OLD_UNHEARD_AT)
    await harness.fence()
    return harness
  }

  it('is not honoured once it names another incarnation', async () => {
    const { store, database } = await fencedRollIsolated()
    await database.query(
      `UPDATE relay_cell_committed_fences SET cell_incarnation = ? WHERE cell_id = ?`,
      [OTHER_INCARNATION, SOURCE.id]
    )
    await expectRefused(hintedAssign(store), 'unheard')
  })

  it('is not honoured once expired', async () => {
    const { store, at } = await fencedRollIsolated()
    await at(OLD_UNHEARD_AT + 5 * 60_000 + 1)
    await expectRefused(hintedAssign(store), 'unheard')
  })

  it('is not honoured when its attempt was aborted', async () => {
    const { store, database } = await fencedRollIsolated()
    await database.query(
      `UPDATE relay_cell_fence_attempts SET aborted_at = ? WHERE attempt_id = ?`,
      [OLD_UNHEARD_AT, FENCE_ATTEMPT_ID]
    )
    await expectRefused(hintedAssign(store), 'unheard')
  })

  it('is not honoured when attested before the last heartbeat', async () => {
    const { store, database } = await fencedRollIsolated()
    await database.query(
      `UPDATE relay_cell_committed_fences SET attested_at = ? WHERE cell_id = ?`,
      [START_MS - 1, SOURCE.id]
    )
    await expectRefused(hintedAssign(store), 'unheard')
  })

  it('is not honoured while the old incarnation still heartbeats', async () => {
    const { store, database, heartbeat } = await fencedRollIsolated()
    // A heartbeat deletes the fence rows; restore them to test the reader on its own.
    const committed = await database.query(`SELECT * FROM relay_cell_committed_fences`)
    const fences = await database.query(`SELECT * FROM relay_cell_fences`)
    await heartbeat(SOURCE, { ready: false })
    expect(await database.query(`SELECT * FROM relay_cell_committed_fences`)).toEqual([])
    await expectRefused(hintedAssign(store), 'not_ready')

    for (const row of fences) {
      await database.query(
        `INSERT INTO relay_cell_fences (cell_id, cell_incarnation, attested_at, expires_at)
         VALUES (?, ?, ?, ?)`,
        [row['cell_id'], row['cell_incarnation'], row['attested_at'], row['expires_at']]
      )
    }
    for (const row of committed) {
      await database.query(
        `INSERT INTO relay_cell_committed_fences
         (cell_id, attempt_id, cell_incarnation, attested_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
        [
          row['cell_id'],
          row['attempt_id'],
          row['cell_incarnation'],
          row['attested_at'],
          row['expires_at']
        ]
      )
    }
    // Same instant as the attest: attested_at >= last_heartbeat_at still holds, so move the
    // heartbeat past it as a later beat would.
    await database.query(
      `UPDATE relay_cell_runtime SET last_heartbeat_at = last_heartbeat_at + 1 WHERE cell_id = ?`,
      [SOURCE.id]
    )
    await expectRefused(hintedAssign(store), 'not_ready')
  })

  it('is not honoured on a general cell, which the writers also refuse', async () => {
    const { store, at, fence } = await setup()
    await at(OLD_UNHEARD_AT)
    await expect(fence()).rejects.toThrow('cell_fence_admission_enabled')
    await expectRefused(hintedAssign(store), 'unheard')
  })

  it('is not honoured once the roll stamp is cleared', async () => {
    const { store, park } = await fencedRollIsolated()
    await park('general')
    await expectRefused(hintedAssign(store), 'unheard')
  })

  it('lets the dead-cell sweep move the host too', async () => {
    const { store } = await fencedRollIsolated()
    expect(await store.evacuateDeadCells()).toBe(1)
    expect((await store.resolve(IDENTITY))?.cellId).toBe(TARGET.id)
  })

  it('leaves the sweep alone without a fence', async () => {
    const { store, at, isolateForRoll } = await setup()
    await isolateForRoll()
    await at(OLD_UNHEARD_AT)
    expect(await store.evacuateDeadCells()).toBe(0)
  })
})
