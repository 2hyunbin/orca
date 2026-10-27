import { beforeEach, describe, expect, it, vi } from 'vitest'

type Move = {
  migrationId: string
  phase: string
  journalKey: string
  destinationEnvironmentId: string
  manifest: {
    source: { distro: string; scopeRepoIds: string[]; scopeFolderWorkspaceIds: string[] }
  }
}

const journal = vi.hoisted(() => ({ chain: new Array<Move>(), released: new Array<string>() }))
const window = vi.hoisted(() => ({ reloads: 0, fences: 0, steps: new Array<string>() }))

function move(migrationId: string, repoId: string): Move {
  return {
    migrationId,
    phase: 'retained',
    journalKey: 'local-wsl:ubuntu',
    destinationEnvironmentId: 'wsl:Ubuntu',
    manifest: {
      source: { distro: 'Ubuntu', scopeRepoIds: [repoId], scopeFolderWorkspaceIds: [] }
    }
  }
}

vi.mock('../persistence/moving-wsl-projects/wsl-move-cutover-journal', () => ({
  listWslMoveCutoverChain: () => [...journal.chain]
}))
vi.mock('../persistence/moving-wsl-projects/wsl-move-use-locally', () => ({
  findWslMovedProjectMove: () => ({ move: journal.chain.at(-1) }),
  wslMoveWorkspacesInScope: () => [],
  // Only the newest move of the chain may come back, as the real journal enforces.
  wslMoveReleaseRefusal: (_userData: string, candidate: Move) =>
    journal.chain.at(-1)?.migrationId === candidate.migrationId
      ? null
      : { released: false, reason: 'superseded' },
  releaseWslMove: (_userData: string, candidate: Move) => {
    journal.chain = journal.chain.filter((entry) => entry.migrationId !== candidate.migrationId)
    journal.released.push(candidate.migrationId)
    return {
      released: true,
      distro: 'Ubuntu',
      repoIds: candidate.manifest.source.scopeRepoIds,
      folderWorkspaceIds: []
    }
  }
}))
vi.mock('../persistence/moving-wsl-projects/wsl-move-undo-spawn-fence', () => ({
  fenceHostSpawnsForWslMoveUndo: () => {
    window.fences++
    return () => {}
  }
}))
vi.mock('../persistence/moving-wsl-projects/wsl-move-window-write-hold', () => ({
  holdWslMoveWindowWrites: () => {
    window.steps.push('hold')
  },
  reloadWslMoveWindowWithWritesHeld: () => {
    window.reloads++
    window.steps.push('reload')
  }
}))

import {
  onWslMoveReleasedByUser,
  releaseWslMoveChainHere,
  releaseWslMovedProjectHere
} from './wsl-move-release-here'

const undoPorts = () => ({ stopHostCopies: vi.fn(async () => 'stopped' as const) })

beforeEach(() => {
  journal.chain = [move('m1', 'r1'), move('m2', 'r2')]
  journal.released = []
  window.reloads = 0
  window.fences = 0
  window.steps = []
})

describe('releasing moved projects here', () => {
  // Review #5: one Restore must bring back every finished move, not only the newest.
  it('releases a whole chain newest first with one reload', async () => {
    const result = await releaseWslMoveChainHere('/user-data', 'Ubuntu', [], undoPorts)
    expect(journal.released).toEqual(['m2', 'm1'])
    expect(result).toEqual({
      released: true,
      distro: 'Ubuntu',
      repoIds: ['r2', 'r1'],
      folderWorkspaceIds: []
    })
    expect(window.reloads).toBe(1)
  })

  it('reloads for what came back even when an older move is refused', async () => {
    const stopHostCopies = vi
      .fn<() => Promise<'stopped' | 'unreachable'>>()
      .mockResolvedValueOnce('stopped')
      .mockResolvedValueOnce('unreachable')
    const result = await releaseWslMoveChainHere('/user-data', 'Ubuntu', [], () => ({
      stopHostCopies
    }))
    expect(journal.released).toEqual(['m2'])
    expect(result).toMatchObject({ released: false, reason: 'host-unreachable' })
    expect(window.reloads).toBe(1)
  })

  // Review #2: only the user's "Use on this computer again" parks the distro; Restore does not.
  it('tells listeners about a user release and not about a Restore', async () => {
    const heard = vi.fn()
    const stop = onWslMoveReleasedByUser(heard)
    await releaseWslMovedProjectHere('/user-data', { repoId: 'r2' }, [], undoPorts)
    expect(heard).toHaveBeenCalledWith('Ubuntu')
    heard.mockClear()
    await releaseWslMoveChainHere('/user-data', 'Ubuntu', [], undoPorts)
    expect(heard).not.toHaveBeenCalled()
    stop()
  })

  // verify-15b 6c: focus left on the host copy reopened its pane after the reload and resumed
  // the agent there beside the one restored here.
  it('returns focus from each released host copy after holding writes and before the reload', async () => {
    const refocusHere = vi.fn((released: Move) => {
      window.steps.push(`refocus ${released.migrationId}`)
    })
    const result = await releaseWslMoveChainHere('/user-data', 'Ubuntu', [], () => ({
      stopHostCopies: vi.fn(async () => 'stopped' as const),
      refocusHere
    }))
    expect(result).toMatchObject({ released: true })
    expect(window.steps).toEqual(['hold', 'refocus m2', 'refocus m1', 'reload'])
  })

  it('returns no focus for a move that did not come back', async () => {
    const refocusHere = vi.fn()
    const stopHostCopies = vi
      .fn<() => Promise<'stopped' | 'unreachable'>>()
      .mockResolvedValueOnce('stopped')
      .mockResolvedValueOnce('unreachable')
    await releaseWslMoveChainHere('/user-data', 'Ubuntu', [], () => ({
      stopHostCopies,
      refocusHere
    }))
    expect(refocusHere.mock.calls.map(([released]) => released.migrationId)).toEqual(['m2'])
  })

  it("turns each move's host automations off before releasing that move", async () => {
    const stopHostAutomations = vi.fn(async (stopped: Move) => {
      // Not released yet when its automations go off on the host.
      expect(journal.released).not.toContain(stopped.migrationId)
      return 'stopped' as const
    })
    const result = await releaseWslMoveChainHere('/user-data', 'Ubuntu', [], () => ({
      stopHostCopies: vi.fn(async () => 'stopped' as const),
      stopHostAutomations
    }))
    expect(result).toMatchObject({ released: true })
    // Partial chains stay per move: each call names only the move being released.
    expect(stopHostAutomations.mock.calls.map(([stopped]) => stopped.migrationId)).toEqual([
      'm2',
      'm1'
    ])
  })

  it('refuses, releasing nothing, when the host cannot turn its automations off', async () => {
    for (const [stop, reason] of [
      ['unreachable', 'host-unreachable'],
      ['failed', 'failed']
    ] as const) {
      journal.chain = [move('m1', 'r1'), move('m2', 'r2')]
      journal.released = []
      window.reloads = 0
      const result = await releaseWslMovedProjectHere('/user-data', { repoId: 'r2' }, [], () => ({
        stopHostCopies: vi.fn(async () => 'stopped' as const),
        stopHostAutomations: vi.fn(async () => stop)
      }))
      expect(result).toMatchObject({ released: false, reason, detail: 'host-automations' })
      expect(journal.released).toEqual([])
      expect(window.reloads).toBe(0)
    }
  })
})
