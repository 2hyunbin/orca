/**
 * D1b-10 fault injection over the real move driver and a real orcad profile store (#29826's
 * pattern): the desktop is killed at every point a clean move passes (each journal write, each
 * host call before it lands and after its reply is lost, each pause step, each desktop rewrite
 * store), optionally with orcad restarted too. After the restart and the reconnect, the move is
 * back at zero or fully moved, never in between; a second restart changes nothing; and a move
 * reset to zero can be run again from scratch.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../../shared/wsl-host-internal-gate'
import { wslMoveJournalKey } from '../../../shared/wsl-move/wsl-move-cutover'
import { createStore, testState } from '../../persistence-test-harness'
import type { Store } from '../loading-store/store'
import {
  createWslMoveWorld,
  type WslMoveWorld
} from '../__fixtures__/wsl-mover/wsl-move-driver-world'
import {
  createWslMoveKillSwitch,
  createWslMoveStoreHost,
  passWslMoveKillPoint,
  type WslMoveKillSwitch
} from '../__fixtures__/wsl-mover/wsl-move-store-host'
import type * as Journal from './wsl-move-cutover-journal'
import { listWslMoveCutoverChain, listWslMoveCutovers } from './wsl-move-cutover-journal'
import { runWslMoveDesktopRewritePass } from './wsl-move-desktop-rewrite'
import {
  registerWslMoveDesktopRewriteStore,
  resetWslMoveDesktopRewriteStoresForTests,
  setWslMoveDesktopRewriteRegistryCompleteForTests
} from './wsl-move-desktop-rewrite-stores'
import { moveProjectsToWslHost } from './wsl-move-driver'
import { resolveWslMoveFence } from './wsl-move-fence'
import { listWslMoveOwedHostAborts, settleWslMoveOwedHostAborts } from './wsl-move-owed-host-aborts'
import { recoverInterruptedWslMoves, resetWslMoveToZero } from './wsl-move-reset'
import { runWslMoveRetentionPass } from './wsl-move-retention'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 1 }))
}))

// The journal's writes and removals are kill points too; the hook is set per test.
const journalKill = vi.hoisted(() => ({ at: null as ((name: string) => void) | null }))
vi.mock('./wsl-move-cutover-journal', async (importOriginal) => {
  const actual = await importOriginal<typeof Journal>()
  const around = <A extends unknown[]>(
    name: (...args: NoInfer<A>) => string,
    run: (...args: A) => void
  ) => {
    return (...args: A): void => {
      journalKill.at?.(`${name(...args)}:before`)
      run(...args)
      journalKill.at?.(`${name(...args)}:after`)
    }
  }
  return {
    ...actual,
    writeWslMoveCutover: around(
      (_path: string, cutover: Parameters<typeof actual.writeWslMoveCutover>[1]) =>
        `journal:${cutover.phase}`,
      actual.writeWslMoveCutover
    ),
    removeWslMoveCutover: around(() => 'journal:remove', actual.removeWslMoveCutover),
    removeUncommittedWslMoveCutover: around(
      () => 'journal:remove-uncommitted',
      actual.removeUncommittedWslMoveCutover
    )
  }
})

const STORE_IDS = ['main-profile', 'renderer-ui', 'browser'] as const
const request = { distro: 'Ubuntu' }

/** `zero-abort-owed`: the desktop is at zero; the host's leftover stage goes on its next contact. */
type Outcome = 'back-at-zero' | 'zero-abort-owed' | 'fully-moved' | 'waiting-for-host' | 'stuck'

type Rig = {
  userDataPath: string
  kill: WslMoveKillSwitch
  world: WslMoveWorld
  host: Store
  rewritten: Map<string, number>
}

let rig: Rig
const dirs: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function newRig(): Rig {
  resetWslMoveDesktopRewriteStoresForTests()
  setWslMoveDesktopRewriteRegistryCompleteForTests(true)
  testState.dir = tempDir('wsl-move-host-')
  const userDataPath = tempDir('wsl-move-desktop-')
  const kill = createWslMoveKillSwitch()
  const world = createWslMoveWorld(userDataPath)
  const next: Rig = { userDataPath, kill, world, host: createStore(), rewritten: new Map() }
  const at = (name: string): void => passWslMoveKillPoint(kill, name)
  journalKill.at = at
  const host = createWslMoveStoreHost({ store: () => next.host, kill })
  world.deps.connectHost = async () => {
    at('connect')
    return host
  }
  const { quiesce } = world.deps
  world.deps.quiesce = {
    sleepWorkspaces: async (ids) => (at('sleep'), quiesce.sleepWorkspaces(ids)),
    livePtyIds: quiesce.livePtyIds,
    captureRestoreHints: async (panes, distro) => (
      at('restore-hints'),
      quiesce.captureRestoreHints(panes, distro)
    ),
    proveExited: async (scope) => (at('prove-exited'), quiesce.proveExited(scope))
  }
  for (const id of STORE_IDS) {
    registerWslMoveDesktopRewriteStore({
      id,
      side: 'main',
      run: () => {
        at(`store:${id}:run`)
        next.rewritten.set(id, 1)
      },
      flush: () => at(`store:${id}:flush`)
    })
  }
  return next
}

const retentionStore = (r: Rig) => ({
  getRepos: () => r.world.repos,
  getFolderWorkspaces: () => [],
  setWslMoveRetainedMarks: () => 1,
  flushPendingOrThrowAsync: async () => {}
})

/** Startup, then the user's next move attempt reaching the host (which settles the old one). */
async function restart(r: Rig, options: { hostUp: boolean; orcadRestarted: boolean }) {
  r.kill.dead = false
  if (options.orcadRestarted) {
    await r.host.flushPendingOrThrowAsync().catch(() => {})
    r.host = createStore()
  }
  await recoverInterruptedWslMoves(r.userDataPath, () => {})
  await runWslMoveDesktopRewritePass({ userDataPath: r.userDataPath, warn: () => {} })
  if (options.hostUp) {
    // What the next move's prepare does once it reaches the host, before it stages anything.
    const key = wslMoveJournalKey('Ubuntu')
    const host = await r.world.deps.connectHost('Ubuntu')
    if (host) {
      await settleWslMoveOwedHostAborts(r.userDataPath, key, host.catalog)
    }
    const head = listWslMoveCutoverChain(r.userDataPath, key).at(-1)
    if (head) {
      await resetWslMoveToZero(
        { userDataPath: r.userDataPath, destination: host?.catalog ?? null },
        head.migrationId
      )
      await r.world.deps.finishOnDesktop()
    }
  }
  await runWslMoveRetentionPass({ userDataPath: r.userDataPath, store: retentionStore(r) })
}

function outcomeOf(r: Rig): Outcome {
  const records = listWslMoveCutovers(r.userDataPath)
  const fence = resolveWslMoveFence(r.userDataPath)
  const onHost = r.host.getRepos().some((repo) => repo.id === 'repo-1')
  if (records.length === 0) {
    const staged = r.host.hasStagedOrcadMigrationCatalog()
    const owed = listWslMoveOwedHostAborts(r.userDataPath).length > 0
    const clean =
      !onHost &&
      (!staged || owed) &&
      fence.fenced.repoIds.size === 0 &&
      fence.hidden.repoIds.size === 0 &&
      fence.sessionFrozen.repoIds.size === 0 &&
      r.rewritten.size === 0
    if (!clean) {
      return 'stuck'
    }
    return owed ? 'zero-abort-owed' : 'back-at-zero'
  }
  const [record] = records
  if (records.length === 1 && record.phase === 'retained') {
    const allOnce = STORE_IDS.every((id) => r.rewritten.get(id) === 1)
    return allOnce &&
      onHost &&
      fence.hidden.repoIds.has('repo-1') &&
      fence.fenced.repoIds.size === 0
      ? 'fully-moved'
      : 'stuck'
  }
  if (records.length === 1 && record.phase === 'blobs-transferred') {
    return 'waiting-for-host'
  }
  return 'stuck'
}

beforeEach(() => {
  vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
  // A killed process's catch handlers warn about the calls that now throw.
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  rig = newRig()
})

afterEach(() => {
  journalKill.at = null
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  resetWslMoveDesktopRewriteStoresForTests()
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

async function killedMove(r: Rig, killAt: string): Promise<void> {
  r.kill.killAt = killAt
  await moveProjectsToWslHost(r.world.deps, request).catch(() => {})
  // Retention runs on the journal change after the move, in the same process.
  await runWslMoveRetentionPass({ userDataPath: r.userDataPath, store: retentionStore(r) }).catch(
    () => {}
  )
  expect(r.kill.dead, `kill point ${killAt} fired`).toBe(true)
}

/** Every kill point a clean move passes, from a throwaway run. */
async function killPoints(): Promise<string[]> {
  const probe = newRig()
  const result = await moveProjectsToWslHost(probe.world.deps, request)
  expect(result).toMatchObject({ outcome: 'moved' })
  await runWslMoveRetentionPass({ userDataPath: probe.userDataPath, store: retentionStore(probe) })
  return [...new Set(probe.kill.points)]
}

describe('WSL move driver fault injection (real host store)', () => {
  it('a clean move ends fully moved on a real host store', async () => {
    expect(await moveProjectsToWslHost(rig.world.deps, request)).toMatchObject({
      outcome: 'moved'
    })
    await runWslMoveRetentionPass({ userDataPath: rig.userDataPath, store: retentionStore(rig) })
    expect(outcomeOf(rig)).toBe('fully-moved')
  })

  it.each([false, true])(
    'every kill point ends at zero or fully moved, and survives a second restart (orcad restarted: %s)',
    { timeout: 120_000 },
    async (orcadRestarted) => {
      const points = await killPoints()
      expect(points.length).toBeGreaterThan(30)
      const matrix: Record<string, { hostDown: Outcome; hostUp: Outcome }> = {}
      for (const killAt of points) {
        const r = newRig()
        await killedMove(r, killAt)
        await restart(r, { hostUp: false, orcadRestarted })
        const hostDown = outcomeOf(r)
        await restart(r, { hostUp: true, orcadRestarted })
        const hostUp = outcomeOf(r)
        matrix[killAt] = { hostDown, hostUp }
        await restart(r, { hostUp: true, orcadRestarted })
        expect(outcomeOf(r), `${killAt}: a second restart changes nothing`).toBe(hostUp)
        if (hostUp === 'back-at-zero') {
          const again = await moveProjectsToWslHost(r.world.deps, request)
          expect(again, `a fresh move after ${killAt}`).toMatchObject({ outcome: 'moved' })
        }
      }
      for (const [killAt, result] of Object.entries(matrix)) {
        expect(['back-at-zero', 'fully-moved'], `${killAt} with the host up`).toContain(
          result.hostUp
        )
        // Without the host, only a possible commit waits; everything else resolves locally.
        expect(
          ['back-at-zero', 'zero-abort-owed', 'fully-moved', 'waiting-for-host'],
          killAt
        ).toContain(result.hostDown)
      }
      // The commit point: a kill before the commit lands resets; one after it moves forward.
      expect(matrix['commit:before']).toEqual({
        hostDown: 'waiting-for-host',
        hostUp: 'back-at-zero'
      })
      expect(matrix['commit:lost-reply']).toEqual({
        hostDown: 'waiting-for-host',
        hostUp: 'fully-moved'
      })
      // A kill after the host staged: the desktop resets alone, and the stage goes on reconnect.
      expect(matrix['journal:destination-staged:after']).toEqual({
        hostDown: 'zero-abort-owed',
        hostUp: 'back-at-zero'
      })
      expect(matrix['store:browser:run']).toEqual({
        hostDown: 'fully-moved',
        hostUp: 'fully-moved'
      })
    }
  )
})
