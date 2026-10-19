import { describe, expect, it, vi } from 'vitest'
import { PtyExitProof, PtyRetirementWithoutProof } from '../../../pty-exit-proof'
import { publishSyntheticExit } from './kill'

function deps() {
  const calls: string[] = []
  return {
    calls,
    deps: {
      runtime: {
        markPtyLivenessUnverifiable: vi.fn((_id: string, reason: string) =>
          calls.push(`unverifiable:${reason}`)
        ),
        onPtyExit: vi.fn(() => {
          calls.push('exit')
        })
      },
      rememberSyntheticKillExit: vi.fn(),
      sendPtyExitToRenderer: vi.fn()
    }
  }
}

describe('a synthetic PTY exit', () => {
  it('reads unverifiable, before the exit lands, when it rests on no proof', () => {
    const { calls, deps: d } = deps()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: publishSyntheticExit reads only these two runtime methods.
    publishSyntheticExit(
      d as never,
      'pty-1',
      -1,
      'inc-1',
      PtyRetirementWithoutProof.because('gone')
    )
    expect(calls).toEqual(['unverifiable:gone', 'exit'])
    expect(d.sendPtyExitToRenderer).toHaveBeenCalledWith({
      id: 'pty-1',
      code: -1,
      incarnationId: 'inc-1'
    })
  })

  it('leaves the liveness verdict to the exit when the host proved it', () => {
    const { calls, deps: d } = deps()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: publishSyntheticExit reads only these two runtime methods.
    publishSyntheticExit(d as never, 'pty-1', 0, undefined, PtyExitProof.from('absent'))
    expect(calls).toEqual(['exit'])
  })
})
