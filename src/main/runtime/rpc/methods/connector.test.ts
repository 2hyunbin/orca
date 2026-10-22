import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { CONNECTOR_METHODS } from './connector'

const CONVERSATION = { source: 'dev', externalId: 'thread-1', deliveryId: 'd1' }

describe('connector RPC methods', () => {
  it.each([
    [
      'connector.start',
      {
        ...CONVERSATION,
        agent: 'claude',
        prompt: 'hi',
        target: { kind: 'existing', worktree: 'id:wt' }
      }
    ]
  ])('%s is refused while the host has connectors off', async (method, params) => {
    const runtime = { getRuntimeId: () => 'test-runtime', getExternalConversationSeam: () => null }
    const dispatcher = new RpcDispatcher({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dispatcher reads only the runtime id, and these handlers only the seam accessor, before refusing.
      runtime: runtime as unknown as OrcaRuntimeService,
      methods: CONNECTOR_METHODS
    })
    await expect(
      dispatcher.dispatch({ id: 'req-1', authToken: 'tok', method, params })
    ).resolves.toMatchObject({ ok: false, error: { code: 'connectors_disabled' } })
  })
})
