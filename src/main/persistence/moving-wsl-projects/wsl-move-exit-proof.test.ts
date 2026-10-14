import { describe, expect, it } from 'vitest'
import { proveWslMoveTerminalsExited } from './wsl-move-exit-proof'

const moved = new Set(['repo::\\\\wsl.localhost\\Ubuntu\\home\\dev\\app'])
const id = (worktreeId: string, n: number) => `${worktreeId}@@${n}`

describe('proveWslMoveTerminalsExited', () => {
  it('proves exit when no live session belongs to a moved workspace', async () => {
    const proof = await proveWslMoveTerminalsExited(
      async () => [
        { sessionId: id([...moved][0], 1), isAlive: false },
        { sessionId: id('other::C:\\src', 2), isAlive: true }
      ],
      moved
    )
    expect(proof).toEqual({ verdict: 'exited' })
  })

  it('names every live session of a moved workspace', async () => {
    const live = id([...moved][0], 3)
    await expect(
      proveWslMoveTerminalsExited(async () => [{ sessionId: live, isAlive: true }], moved)
    ).resolves.toEqual({ verdict: 'live', sessionIds: [live] })
  })

  it('never reads a census it could not take as exit', async () => {
    await expect(
      proveWslMoveTerminalsExited(async () => {
        throw new Error('daemon unreachable')
      }, moved)
    ).resolves.toEqual({ verdict: 'unverifiable', reason: 'daemon unreachable' })
  })
})
