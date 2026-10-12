import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { emptyLayoutViewRecord } from '../../../../shared/workspace-layout/workspace-layout-views'
import { eraseRpcMethods, isStreamingMethod, type RpcContext } from '../core'
import { WORKSPACE_LAYOUT_VIEW_METHODS } from './workspace-layout-views'

const setState = eraseRpcMethods(WORKSPACE_LAYOUT_VIEW_METHODS).find(
  (method) => method.name === 'view.setState'
)

describe('view.setState', () => {
  it("writes the sender's own view: the local window's desktop, a paired client's device", async () => {
    const setRecord = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler calls only layoutCommands.views.setRecord.
    const runtime = { layoutCommands: { views: { setRecord } } } as unknown as OrcaRuntimeService
    if (!setState || isStreamingMethod(setState)) {
      throw new Error('view.setState is not a request method')
    }
    const record = emptyLayoutViewRecord()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only runtime and pairedDeviceId from its context.
    await setState.handler({ record, viewId: 'desktop' }, { runtime } as RpcContext)
    await setState.handler(
      { record, viewId: 'desktop' },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only runtime and pairedDeviceId from its context.
      { runtime, pairedDeviceId: 'phone-1' } as RpcContext
    )
    expect(setRecord.mock.calls).toEqual([
      ['desktop', record],
      ['device:phone-1', record]
    ])
  })
})
