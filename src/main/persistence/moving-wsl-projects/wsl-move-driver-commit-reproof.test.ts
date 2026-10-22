/**
 * R46: the quiesce proves every terminal in scope exited, but the commit comes later. A terminal
 * that started in between must be refused by the fence, or block the commit and reset the move.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../../shared/wsl-host-internal-gate'
import {
  createWslMoveWorld,
  type WslMoveWorld
} from '../__fixtures__/wsl-mover/wsl-move-driver-world'
import { listWslMoveCutovers } from './wsl-move-cutover-journal'
import {
  registerWslMoveDesktopRewriteStore,
  resetWslMoveDesktopRewriteStoresForTests,
  setWslMoveDesktopRewriteRegistryCompleteForTests
} from './wsl-move-desktop-rewrite-stores'
import { moveProjectsToWslHost } from './wsl-move-driver'
import type { WslMoveExitProof, WslMoveExitProofScope } from './wsl-move-exit-proof'
import {
  isWslMoveCwdFenced,
  loadWslMoveFence,
  resetWslMoveFenceForTests
} from './wsl-move-scope-guard'

let userDataPath: string
let world: WslMoveWorld

beforeEach(() => {
  vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
  userDataPath = mkdtempSync(join(tmpdir(), 'wsl-move-reproof-'))
  world = createWslMoveWorld(userDataPath)
  loadWslMoveFence(userDataPath)
  setWslMoveDesktopRewriteRegistryCompleteForTests(true)
  registerWslMoveDesktopRewriteStore({
    id: 'ui-routing',
    side: 'main',
    run: () => {},
    flush: () => {}
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
  resetWslMoveFenceForTests()
  resetWslMoveDesktopRewriteStoresForTests()
  rmSync(userDataPath, { recursive: true, force: true })
})

const request = { distro: 'Ubuntu' }

/** The quiesce's proof answers `exited`; the next one answers `later`. */
function proofsThen(later: WslMoveExitProof): WslMoveExitProofScope[] {
  const scopes: WslMoveExitProofScope[] = []
  world.deps.quiesce.proveExited = async (scope) => {
    scopes.push(scope)
    world.points.push('prove-exited')
    return scopes.length === 1 ? { verdict: 'exited' } : later
  }
  return scopes
}

describe('the exit proof again before the commit', () => {
  it('runs after the last blob and right before the commit, with the quiesce scope', async () => {
    const scopes = proofsThen({ verdict: 'exited' })

    expect(await moveProjectsToWslHost(world.deps, request)).toMatchObject({ outcome: 'moved' })
    expect(world.points.filter((point) => point === 'prove-exited')).toHaveLength(2)
    expect(world.points.slice(-3, -1)).toEqual(['prove-exited', 'commit:before'])
    expect(scopes[1]).toEqual(scopes[0])
    expect([...scopes[1].sessionIds]).toEqual(['session-1'])
  })

  it.each<[string, WslMoveExitProof]>([
    ['live', { verdict: 'live', sessionIds: ['bare-session'] }],
    ['unverifiable', { verdict: 'unverifiable', reason: 'a daemon generation did not answer' }]
  ])('blocks the commit and resets when a terminal reads %s', async (_label, proof) => {
    proofsThen(proof)

    const result = await moveProjectsToWslHost(world.deps, request)

    expect(result).toEqual({
      outcome: 'refused',
      code: 'wsl_move_pause_failed',
      detail: 'terminals-started-after-pause'
    })
    expect(world.points).not.toContain('commit:before')
    // Back to zero on both sides: the journal record is gone and the host's staging aborted.
    expect(listWslMoveCutovers(userDataPath)).toEqual([])
    expect([...world.catalog.values()]).toEqual([])
    expect(isWslMoveCwdFenced('/home/dev/app')).toBe(false)
  })

  it('resets without the host, since nothing asked it to commit yet', async () => {
    proofsThen({ verdict: 'live', sessionIds: ['bare-session'] })
    const connect = world.deps.connectHost
    world.deps.connectHost = async (distro) => {
      const host = await connect(distro)
      const readState = host?.catalog.readState
      if (host && readState) {
        // The host goes away once the blobs are sent; the reset must not wait for it.
        host.catalog.readState = async (manifest) => {
          if (world.points.filter((point) => point === 'prove-exited').length > 1) {
            throw new Error('host unreachable')
          }
          return readState(manifest)
        }
      }
      return host
    }

    const result = await moveProjectsToWslHost(world.deps, request)

    expect(result).toMatchObject({ outcome: 'refused', code: 'wsl_move_pause_failed' })
    expect(listWslMoveCutovers(userDataPath)).toEqual([])
  })

  it('refuses a terminal with no workspace that starts in a moving folder after the quiesce', async () => {
    let fencedAfterQuiesce: boolean[] = []
    world.deps.quiesce.proveExited = async () => {
      world.points.push('prove-exited')
      fencedAfterQuiesce = [
        isWslMoveCwdFenced('\\\\wsl.localhost\\Ubuntu\\home\\dev\\app\\src'),
        isWslMoveCwdFenced('/home/dev/app'),
        isWslMoveCwdFenced('\\\\wsl.localhost\\Ubuntu\\home\\dev\\other')
      ]
      return { verdict: 'exited' }
    }

    expect(await moveProjectsToWslHost(world.deps, request)).toMatchObject({ outcome: 'moved' })
    // Read at the second proof, between the blobs and the commit request.
    expect(fencedAfterQuiesce).toEqual([true, true, false])
  })
})
