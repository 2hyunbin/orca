import { afterEach, expect, it } from 'vitest'
import { openAttachedHostRig, send, hello, framesOf } from './acp-structured-host.test-support'
import { PROVIDER_SESSION, waitFor } from './acp-structured-adapter.test-support'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { HOST_TEST_SESSION as SESSION } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { commandReceiptScope } from '../native-chat/agent-session-journal/command-receipt-schema'
import { createStructuredMailboxPointerHost } from '../runtime/orchestration/structured-mailbox-pointer-host'
import { mintAgentSessionOperationId } from '../runtime/orchestration/structured-pointer-operation-id'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'

afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await closeProviderTimelineRigs()
})

const mailNotice: AgentJournalMessageItem = {
  ...hello,
  from: {
    kind: 'agent',
    senders: [],
    orchestration: { message: 'mail-notice', mailbox: 'run:r1', dispatchId: null, messages: [] }
  }
}

function sendMail(host: StructuredAgentSessionHost, operationId: string) {
  return createStructuredMailboxPointerHost().send({
    sessionId: SESSION,
    dispatchId: null,
    operationId,
    expectedRuntimeFence: host.deps.store.getRecord(SESSION)!.lease.runtimeFence,
    body: mailNotice
  })
}

it('holds mail while an ACP turn runs instead of cancelling it, then sends it once the chat is idle', async () => {
  const { host, rig } = await openAttachedHostRig()
  setStructuredAgentSessionHost(host)
  await send(host, 'work')
  const prompt = await rig.frame('session/prompt')
  const pointer = createStructuredMailboxPointerHost()
  await waitFor(() => expect(pointer.takesMailNow(SESSION)).toBe(false))
  const operationId = mintAgentSessionOperationId(Date.now())
  expect(await sendMail(host, operationId)).toEqual({ kind: 'held' })
  expect(framesOf(rig.child(), 'session/cancel')).toHaveLength(0)
  rig.child().agent.reply(prompt, { stopReason: 'end_turn' })
  await waitFor(() => expect(pointer.takesMailNow(SESSION)).toBe(true))
  const sent = sendMail(host, operationId)
  rig.child().agent.reply(await rig.frame('session/prompt', 1), { stopReason: 'end_turn' })
  expect(await sent).toMatchObject({ kind: 'sent' })
  expect(framesOf(rig.child(), 'session/cancel')).toHaveLength(0)
  await host.close(SESSION, 'user-close')
})

it('holds mail without interrupting an answerable ACP question', async () => {
  const { host, rig } = await openAttachedHostRig()
  setStructuredAgentSessionHost(host)
  await send(host, 'work')
  await rig.frame('session/prompt')
  void rig.child().agent.request(601, 'x.ai/ask_user_question', {
    sessionId: PROVIDER_SESSION,
    toolCallId: 'question-1',
    questions: [{ question: 'Which file?', options: [{ label: 'a.ts' }] }]
  })
  await waitFor(() => expect(host.currentWork(SESSION)?.hasActionablePrompt()).toBe(true))
  const operationId = mintAgentSessionOperationId(Date.now())
  expect(await sendMail(host, operationId)).toEqual({ kind: 'held' })
  expect((await host.journalSnapshot(SESSION)).submissions).toHaveLength(1)
  expect(
    host.deps.store.readCommandReceipt(commandReceiptScope('any', 'global'), operationId)
  ).toMatchObject({ verdict: 'absent' })
  expect(framesOf(rig.child(), 'session/cancel')).toHaveLength(0)
  await host.close(SESSION, 'user-close')
})
