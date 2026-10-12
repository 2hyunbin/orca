import { expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import {
  createRestTestRig,
  REST_TEST_CALLER as CALLER,
  REST_TEST_SESSION as SESSION,
  restTestSend
} from './structured-agent-session-rest-test-rig'
import {
  hostTestAttachParams,
  hostTestOperationId
} from './structured-agent-session-host-test-data'

it('keeps startup permission, model and effort picks through delivery and runtime replacement', async () => {
  const rig = await createRestTestRig({ idleSweep: { intervalMs: 3_600_000 } })
  try {
    const acquire = rig.adapter.acquire.getMockImplementation()
    if (!acquire) {
      throw new Error('missing test acquisition')
    }
    rig.adapter.acquire.mockImplementationOnce(rig.heldStart(acquire))
    const writes = vi.spyOn(rig.host.deps.adapter, 'setOption')
    const attached = await rig.host.attach(CALLER, {
      ...hostTestAttachParams(null),
      options: { model: 'launched-model', effort: 'low' }
    })
    if (!attached.ok) {
      throw new Error('test attach refused')
    }
    const firstChild = await rig.adapter.acquire.mock.results[0].value
    const sent = await rig.host.send(CALLER, restTestSend('held while starting', attached.fence))
    expect(sent.ok).toBe(true)
    for (const [key, value] of [
      ['effort', 'high'],
      ['permissionMode', 'full-access'],
      ['model', 'picked-model']
    ]) {
      const fields = { key, value }
      expect(
        await rig.host.setOption(CALLER, {
          envelope: {
            sessionId: SESSION,
            clientOperationId: hostTestOperationId(),
            expectedRuntimeFence: attached.fence,
            payloadFingerprint: computeAgentSessionPayloadFingerprint({
              method: 'agentSession.setOption',
              sessionId: SESSION,
              fields
            })
          },
          ...fields
        })
      ).toMatchObject({ ok: true })
    }
    expect(writes).not.toHaveBeenCalled()
    expect(rig.adapter.dispatch).not.toHaveBeenCalled()

    await rig.host.handleAdapterEvent({
      type: 'started',
      sessionId: SESSION,
      fence: attached.fence,
      acquisitionGeneration: firstChild.acquisitionGeneration!,
      reportedOptions: { model: 'launched-model', effort: 'low' },
      restoreSkippedOptions: [],
      optionRevision: -1
    })
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledOnce())
    expect(writes.mock.calls.map(([input]) => [input.key, input.value])).toEqual([
      ['model', 'picked-model'],
      ['effort', 'high']
    ])
    const options = { model: 'picked-model', effort: 'high', permissionMode: 'full-access' }
    expect(rig.adapter.closeSession).toHaveBeenCalledOnce()
    expect(rig.adapter.acquire).toHaveBeenCalledTimes(2)
    expect(rig.adapter.acquire).toHaveBeenLastCalledWith(
      expect.objectContaining({ permissionMode: 'full-access', options })
    )
    expect(rig.adapter.acquire.mock.invocationCallOrder[1]).toBeLessThan(
      rig.adapter.dispatch.mock.invocationCallOrder[0]
    )
    expect(rig.store.getRecord(SESSION)?.options).toEqual(options)

    await rig.restart()
    expect((await rig.host.readOptions(SESSION)).current.permissionMode).toBe('full-access')
    const nextFence = rig.store.getRecord(SESSION)!.lease.runtimeFence
    expect((await rig.host.send(CALLER, restTestSend('after restart', nextFence))).ok).toBe(true)
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(2))
    expect(rig.adapter.acquire).toHaveBeenLastCalledWith(
      expect.objectContaining({ permissionMode: 'full-access', options })
    )
  } finally {
    await rig.dispose()
  }
})
