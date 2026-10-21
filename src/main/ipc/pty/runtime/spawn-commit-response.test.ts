import { describe, expect, it } from 'vitest'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { completeRuntimeSpawnResponse } from './spawn-commit-response'
import { createRuntimePtySpawnState, type RuntimePtySpawnArgs } from './spawn-state'
import type { PtyRuntimeControllerDeps } from './controller-deps'

type Facts = { resumed?: boolean; unavailable?: boolean; dropped?: boolean; isReattach?: boolean }

/** A committed spawn's reply, from a start that did or did not ask to resume an agent. */
function reply({ resumed = false, unavailable = false, dropped = false, isReattach }: Facts) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reply reads no deps; a key-less reservation resolves nothing.
  const deps = {} as unknown as PtyRuntimeControllerDeps
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reply reads only the grid and the resume asked for.
  const args = {
    cols: 120,
    rows: 40,
    ...(resumed ? { resumeProviderSession: { key: 'session_id', id: 'codex-session-1' } } : {})
  } as unknown as RuntimePtySpawnArgs
  const ctx = createRuntimePtySpawnState(deps, args)
  ctx.result = { id: 'pty-1', ...(isReattach ? { isReattach } : {}) }
  ctx.codexResumeUnavailable = unavailable
  ctx.codexResumeArgvDropped = dropped || unavailable
  return completeRuntimeSpawnResponse(ctx)
}

describe("a runtime spawn's resume outcome", () => {
  const on = <T>(value: T): T | undefined => (ORCA_LAYOUT_OWNER_IS_MAIN ? value : undefined)

  it('says a resumed start restored its agent, switch-on only', () => {
    expect(reply({ resumed: true }).resumeOutcome).toBe(on('restored'))
  })

  it('says a start whose unverified resume was dropped runs a fresh session', () => {
    expect(reply({ resumed: true, unavailable: true }).resumeOutcome).toBe(on('resume-unavailable'))
  })

  it('says nothing for a plain start, a silently dropped resume, or a reattach', () => {
    expect(reply({}).resumeOutcome).toBeUndefined()
    expect(reply({ resumed: true, dropped: true }).resumeOutcome).toBeUndefined()
    expect(reply({ resumed: true, isReattach: true }).resumeOutcome).toBeUndefined()
  })
})
