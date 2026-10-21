import { describe, expect, it } from 'vitest'
import {
  AgentSessionResumeClaims,
  type AgentSessionResumeHold
} from './agent-session-resume-claims'

const SESSION = { agent: 'claude', providerSession: { key: 'session_id', id: 'one' } } as const

describe('AgentSessionResumeClaims', () => {
  it('refuses a second pane, and a fresh-pane resume, while one is unsettled', () => {
    const claims = new AgentSessionResumeClaims(() => false)
    expect(claims.claim(SESSION, 'tab:a')).not.toBeNull()
    expect(claims.claim(SESSION, 'tab:b')).toBeNull()
    expect(claims.claim(SESSION, null)).toBeNull()
    expect(claims.isHeldElsewhere(SESSION, 'tab:b')).toBe(true)
    expect(claims.isHeldElsewhere(SESSION, 'tab:a')).toBe(false)
    expect(
      claims.claim({ ...SESSION, providerSession: { key: 'session_id', id: 'two' } }, 'tab:b')
    ).not.toBeNull()
  })

  it('shares one pane between overlapping opens until every open releases', () => {
    const claims = new AgentSessionResumeClaims(() => false)
    const first = claims.claim(SESSION, 'tab:a')
    const second = claims.claim(SESSION, 'tab:a')
    first?.release()
    expect(claims.claim(SESSION, 'tab:b')).toBeNull()
    second?.release()
    expect(claims.claim(SESSION, 'tab:b')).not.toBeNull()
  })

  it('keeps a bound hold past its claimant until it settles', () => {
    let settled = false
    const seen: AgentSessionResumeHold[] = []
    const claims = new AgentSessionResumeClaims((hold) => {
      seen.push(hold)
      return settled
    })
    const claim = claims.claim(SESSION, null)
    claim?.bind({ paneKey: 'tab:new', ptyId: 'pty-1' })
    claim?.release()
    expect(claims.claim(SESSION, 'tab:a')).toBeNull()
    expect(seen.at(-1)).toMatchObject({ paneKey: 'tab:new', ptyId: 'pty-1' })

    settled = true
    expect(claims.claim(SESSION, 'tab:a')).not.toBeNull()
  })
})
