import { describe, expect, it } from 'vitest'
import { proveWslMoveTerminalsExited } from './wsl-move-exit-proof'

const moved = new Set(['repo::\\\\wsl.localhost\\Ubuntu\\home\\dev\\app'])
const scope = { worktreeIds: moved, sessionIds: new Set<string>() }
const id = (worktreeId: string, n: number) => `${worktreeId}@@${n}`

describe('proveWslMoveTerminalsExited', () => {
  it('proves exit when no live session belongs to a moved workspace', async () => {
    const proof = await proveWslMoveTerminalsExited(
      async () => [
        { sessionId: id([...moved][0], 1), isAlive: false },
        { sessionId: id('other::C:\\src', 2), isAlive: true }
      ],
      scope
    )
    expect(proof).toEqual({ verdict: 'exited' })
  })

  it('names every live session of a moved workspace', async () => {
    const live = id([...moved][0], 3)
    await expect(
      proveWslMoveTerminalsExited(async () => [{ sessionId: live, isAlive: true }], scope)
    ).resolves.toEqual({ verdict: 'live', sessionIds: [live] })
  })

  it('never reads a census it could not take as exit', async () => {
    await expect(
      proveWslMoveTerminalsExited(async () => {
        throw new Error('daemon unreachable')
      }, scope)
    ).resolves.toEqual({ verdict: 'unverifiable', reason: 'daemon unreachable' })
  })

  it('counts a live pane session whose id predates the minted format', async () => {
    await expect(
      proveWslMoveTerminalsExited(async () => [{ sessionId: 'legacy-uuid', isAlive: true }], {
        worktreeIds: moved,
        sessionIds: new Set(['legacy-uuid'])
      })
    ).resolves.toEqual({ verdict: 'live', sessionIds: ['legacy-uuid'] })
  })
})
