import { afterEach, describe, expect, it, vi } from 'vitest'
import { RUNTIME_CAPABILITIES } from '../../../../shared/protocol-version'
import { SESSION_TERMINAL_SCROLLBACK_READ_RUNTIME_CAPABILITY } from '../../../../shared/session-tabs-runtime-capabilities'
import { ORCA_E2E_WSL_MOVE_DESTINATION_ENV } from '../../../orcad/orcad-migration-wsl-destination'
import { sessionTerminalScrollbackMethodsForThisHost } from './session-terminal-scrollback'
import { SessionReadTerminalScrollbackParams } from '../../../../shared/rpc-contract/session-terminal-scrollback-params'
import { MOBILE_RPC_METHOD_ALLOWLIST } from '../../runtime-rpc/runtime-rpc-mobile-method-allowlist'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('session.readTerminalScrollback', () => {
  it('is registered once, as a workspace method, only on a WSL move destination', () => {
    vi.stubEnv(ORCA_E2E_WSL_MOVE_DESTINATION_ENV, '1')
    const methods = sessionTerminalScrollbackMethodsForThisHost()
    expect(methods.map((method) => method.name)).toEqual(['session.readTerminalScrollback'])
    expect(methods[0]?.permission).toBe('workspace')
    expect(MOBILE_RPC_METHOD_ALLOWLIST.has('session.readTerminalScrollback')).toBe(true)
  })

  it('is absent, and not advertised by default, on every other host', () => {
    expect(sessionTerminalScrollbackMethodsForThisHost()).toEqual([])
    expect(RUNTIME_CAPABILITIES).not.toContain(SESSION_TERMINAL_SCROLLBACK_READ_RUNTIME_CAPABILITY)
  })

  it('accepts only snapshot-shaped refs and a worktree selector', () => {
    const ok = { worktree: 'id:repo::/wt', ref: `v1-${'0'.repeat(32)}` }
    expect(SessionReadTerminalScrollbackParams.safeParse(ok).success).toBe(true)
    for (const ref of ['../secrets', `v1-${'0'.repeat(31)}`, 'v1-ZZ', '']) {
      expect(SessionReadTerminalScrollbackParams.safeParse({ ...ok, ref }).success).toBe(false)
    }
    expect(
      SessionReadTerminalScrollbackParams.safeParse({ ref: ok.ref, worktree: '' }).success
    ).toBe(false)
  })
})
