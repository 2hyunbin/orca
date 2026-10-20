import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import type { RpcDispatchStreamingOptions } from '../dispatcher-stream-options'
import { SIDEBAR_INPUT_METHODS } from './sidebar-inputs'

function makeHost() {
  const noteWindowSleptWorkspaces = vi.fn()
  const fake = { getRuntimeId: () => 'test-runtime', sidebarFacts: { noteWindowSleptWorkspaces } }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the method reads only sidebarFacts.noteWindowSleptWorkspaces.
  const runtime = fake as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: SIDEBAR_INPUT_METHODS })
  const report = (context: RpcDispatchStreamingOptions) =>
    dispatcher.dispatch(
      {
        id: 'req-1',
        authToken: 'tok',
        method: 'sidebarSession.sleptWorkspaces',
        params: { worktreeIds: ['repo-1::/r/a'] }
      },
      context
    )
  return { report, noteWindowSleptWorkspaces }
}

describe('sidebarSession.sleptWorkspaces', () => {
  it('takes the set from this host’s own window, keyed by its connection', async () => {
    const host = makeHost()
    const response = await host.report({
      clientKind: 'runtime',
      caller: { kind: 'desktop' },
      connectionId: 'desktop-renderer:1:1'
    })
    expect(response).toMatchObject({ ok: true })
    expect(host.noteWindowSleptWorkspaces).toHaveBeenCalledWith('desktop-renderer:1:1', [
      'repo-1::/r/a'
    ])
  })

  it('refuses a phone, a paired desktop and an unidentified client', async () => {
    const host = makeHost()
    for (const context of [
      { clientKind: 'mobile', connectionId: 'conn-1' },
      { clientKind: 'runtime', connectionId: 'conn-1' },
      {
        clientKind: 'runtime',
        connectionId: 'conn-1',
        caller: { kind: 'paired-device', deviceId: 'desktop-device' }
      }
    ] satisfies RpcDispatchStreamingOptions[]) {
      expect(await host.report(context)).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    }
    expect(host.noteWindowSleptWorkspaces).not.toHaveBeenCalled()
  })
})
