// Which clients get a send answered at acceptance, and which have their reply held until the
// message is handed over: a client that cannot show a rejection after `pending` must not see one.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../../shared/electron-remote-runtime-client-capabilities'
import { DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES } from '../../../ipc/desktop-renderer-runtime-capabilities'
import { STRUCTURED_AGENT_SESSION_START_WAIT_MS } from '../../../native-chat/agent-session-wire/structured-agent-session-send-settlement'
import {
  call,
  clearStructuredHostStub,
  hostCalls,
  installStructuredHostStub,
  SESSION,
  sendParams,
  STRUCTURED_CLIENT,
  STRUCTURED_MOBILE_CLIENT
} from './structured-agent-session-rpc.test-fixture'

import {
  createQueuedMessageTestRig,
  eventually
} from '../../../native-chat/agent-session-wire/structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as HOST_SESSION,
  hostTestMessage,
  hostTestOperationId
} from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { holdDelivery } from '../../../native-chat/agent-session-wire/structured-agent-session-delivery-hold.test-fixture'

beforeEach(() => {
  installStructuredHostStub()
})

afterEach(() => {
  clearStructuredHostStub()
})

describe('agentSession.send reply timing', () => {
  it('holds a pending reply until handover for a client that cannot show a later rejection', async () => {
    hostCalls.send.mockResolvedValueOnce(pendingSendResult())
    hostCalls.waitForSendSettlement.mockResolvedValueOnce(undefined)

    await call('agentSession.send', sendParams(), STRUCTURED_CLIENT)

    expect(hostCalls.waitForSendSettlement).toHaveBeenCalledWith(SESSION, 'client-1', {
      until: 'handed-over-or-behind-command',
      budgetMs: STRUCTURED_AGENT_SESSION_START_WAIT_MS
    })
  })

  it('answers at acceptance for the local desktop and paired desktop clients (W2)', async () => {
    for (const clientCapabilities of [
      DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES,
      // A paired desktop gains the structured surface as its own capability; the reply rule rides
      // on the list it already sends.
      [...ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES, STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
    ]) {
      hostCalls.send.mockResolvedValueOnce(pendingSendResult())
      const response = await call('agentSession.send', sendParams(), {
        clientKind: 'runtime',
        clientCapabilities: [...clientCapabilities]
      })
      expect(response).toMatchObject({
        ok: true,
        result: { value: { submission: { dispatchState: 'pending' } } }
      })
    }
    expect(hostCalls.waitForSendSettlement).not.toHaveBeenCalled()
  })
})

function pendingSendResult() {
  return {
    ok: true,
    replayed: false,
    fence: 1,
    cursor: { epoch: 'epoch-a', sequence: 1 },
    value: {
      clientMessageId: 'client-1',
      submission: {
        clientMessageId: 'client-1',
        fence: 1,
        payloadFingerprint: 'fingerprint',
        dispatchState: 'pending' as const,
        providerItemId: null,
        reason: null,
        submittedAt: 1,
        resolvedAt: null,
        handoverRecorded: true as const
      }
    }
  }
}

it('keeps an old phone image send immediate and never recovers its interrupted send as a hidden card', async () => {
  const rig = await createQueuedMessageTestRig()
  hostCalls.send.mockImplementation(rig.host.send.bind(rig.host))
  const imageSend = () => {
    const body = hostTestMessage('from an old phone')
    body.blocks.push({ type: 'image-ref', path: '/tmp/shot.png' })
    const fields = { body, delivery: 'queue-if-active' as const }
    const id = hostTestOperationId()
    return { id, request: { envelope: rig.envelope(fields, 'agentSession.send', id), ...fields } }
  }
  let release = () => {}
  try {
    const working = await rig.workingSend()
    const image = imageSend()
    expect(await call('agentSession.send', image.request, STRUCTURED_MOBILE_CLIENT)).toMatchObject({
      ok: true,
      result: { value: { submission: { clientMessageId: image.id } } }
    })
    expect(await rig.drafts()).toEqual([])
    await rig.settleAccepted(working, 'working')
    await eventually(async () => {
      expect((await rig.submission(image.id))?.handedOverAt).toBeDefined()
      expect(
        rig.dispatch.mock.calls.find(([input]) => input.clientMessageId === image.id)?.[0].body
      ).toEqual(image.request.body)
    })
    await rig.settleAccepted(image.id, 'image')

    const hold = holdDelivery()
    release = hold.release
    const interrupted = imageSend()
    expect(
      await call('agentSession.send', interrupted.request, STRUCTURED_MOBILE_CLIENT)
    ).toMatchObject({ ok: true, result: { value: { submission: expect.anything() } } })
    await hold.held
    const closed = rig.host.close(HOST_SESSION, 'user-close')
    release()
    await closed
    rig.crashRestartHostProcess()
    expect(await rig.drafts()).toEqual([])
    expect(await rig.submission(interrupted.id)).toMatchObject({
      source: { kind: 'user' },
      dispatchState: 'rejected'
    })
    expect(await rig.submission(interrupted.id)).not.toHaveProperty('keptAsQueuedMessageId')
  } finally {
    release()
    await rig.dispose()
  }
})
