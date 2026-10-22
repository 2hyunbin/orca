import { describe, expect, it } from 'vitest'
import { AgentSessionResumeClaims } from './agent-session-resume-claims'

const SESSION = { agent: 'claude', providerSession: { key: 'session_id', id: 'one' } } as const

function makeClaims(reported = () => false, panePtyIds: string[] = []) {
  const exits = new Map<string, () => void>()
  const claims = new AgentSessionResumeClaims({
    reported,
    panePtyIds: () => panePtyIds,
    watchExit: (ptyId, onExit) => {
      exits.set(ptyId, onExit)
      return () => exits.delete(ptyId)
    }
  })
  return { claims, exits, panePtyIds }
}

describe('AgentSessionResumeClaims', () => {
  it('refuses another pane while one is unsettled', () => {
    const { claims } = makeClaims()
    expect(claims.claim(SESSION, 'tab:a')).not.toBeNull()
    expect(claims.claim(SESSION, 'tab:b')).toBeNull()
    expect(
      claims.claim({ ...SESSION, providerSession: { key: 'session_id', id: 'two' } }, 'tab:b')
    ).not.toBeNull()
  })

  it('shares one pane between overlapping opens until every open releases', () => {
    const { claims } = makeClaims()
    const first = claims.claim(SESSION, 'tab:a')
    const second = claims.claim(SESSION, 'tab:a')
    first?.release()
    expect(claims.claim(SESSION, 'tab:b')).toBeNull()
    second?.release()
    expect(claims.claim(SESSION, 'tab:b')).not.toBeNull()
  })

  it('ends a bound hold when its PTY exits, and stops watching it', () => {
    const { claims, exits } = makeClaims()
    claims.claim(SESSION, 'tab:a')?.bind('pty-1')
    expect(claims.claim(SESSION, 'tab:b')).toBeNull()

    exits.get('pty-1')?.()
    expect(exits.has('pty-1')).toBe(false)
    expect(claims.claim(SESSION, 'tab:b')).not.toBeNull()
  })

  it('binds a spawned-then-failed create to the PTY its pane gained since the claim', () => {
    const { claims, exits, panePtyIds } = makeClaims(() => false, ['old-pty'])
    const claim = claims.claim(SESSION, 'tab:a')
    panePtyIds.push('new-pty')
    claim?.bind()
    expect([...exits.keys()]).toEqual(['new-pty'])
  })

  it('ends a hold once the hook store reports it in its pane', () => {
    let reported = false
    const { claims, exits } = makeClaims(() => reported)
    claims.claim(SESSION, 'tab:a')?.bind('pty-1')
    reported = true
    expect(claims.claim(SESSION, 'tab:b')).not.toBeNull()
    expect(exits.has('pty-1')).toBe(false)
  })
})
