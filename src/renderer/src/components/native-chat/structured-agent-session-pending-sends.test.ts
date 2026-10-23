import { afterEach, expect, it } from 'vitest'
import {
  clearStructuredAgentSessionPendingSends,
  getStructuredAgentSessionPendingSends,
  getStructuredAgentSessionSendNotice,
  holdStructuredAgentSessionSends,
  publishStructuredAgentSessionSends,
  setStructuredAgentSessionSendNotice,
  structuredAgentSessionSendsHeld,
  structuredAgentSessionsWithPendingSends,
  subscribeToStructuredAgentSessionPendingSends,
  updateStructuredAgentSessionPendingSend,
  type StructuredAgentSessionPendingSend
} from './structured-agent-session-pending-sends'

const cleanups: (() => void)[] = []

function watch(sessionId: string, listener: () => void = () => undefined): () => void {
  const unsubscribe = subscribeToStructuredAgentSessionPendingSends(sessionId, listener)
  cleanups.push(unsubscribe)
  return unsubscribe
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    cleanup()
  }
  for (const sessionId of structuredAgentSessionsWithPendingSends()) {
    clearStructuredAgentSessionPendingSends(sessionId)
  }
})

it('releases empty records after repeatedly opening and leaving chats', () => {
  const leaveFirstView = watch('visible')
  const leaveSecondView = watch('visible')
  leaveFirstView()
  expect(structuredAgentSessionsWithPendingSends()).toEqual(['visible'])
  leaveSecondView()
  for (let index = 0; index < 1_000; index++) {
    watch(`visited-${index}`)()
  }
  expect(structuredAgentSessionsWithPendingSends()).toEqual([])
})

it('keeps an unwatched pending send until it settles', () => {
  const sessionId = 'pending'
  const entry: StructuredAgentSessionPendingSend = {
    sessionId,
    clientMessageId: 'message',
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'keep me' }] },
    previewUris: [],
    queuedAt: 1,
    phase: 'sending',
    issued: true
  }
  const entries = [entry]
  const unsubscribe = watch(sessionId)
  publishStructuredAgentSessionSends(sessionId, { entries })
  unsubscribe()

  expect(getStructuredAgentSessionPendingSends(sessionId)).toBe(entries)
  updateStructuredAgentSessionPendingSend(sessionId, entry.clientMessageId, null)
  expect(getStructuredAgentSessionPendingSends(sessionId)).toEqual([])
  expect(structuredAgentSessionsWithPendingSends()).toEqual([])
})

it('keeps a notice across unmounts and an obsolete unsubscribe', () => {
  const sessionId = 'notice'
  const unsubscribe = watch(sessionId)
  setStructuredAgentSessionSendNotice(sessionId, 'The message was not sent.')
  unsubscribe()
  expect(getStructuredAgentSessionSendNotice(sessionId)).toBe('The message was not sent.')

  clearStructuredAgentSessionPendingSends(sessionId)
  setStructuredAgentSessionSendNotice(sessionId, 'A newer notice.')
  unsubscribe()
  expect(getStructuredAgentSessionSendNotice(sessionId)).toBe('A newer notice.')
})

it('keeps an unwatched hold until its idempotent release', () => {
  const sessionId = 'held'
  const unsubscribe = watch(sessionId)
  const release = holdStructuredAgentSessionSends(sessionId)
  cleanups.push(release)
  unsubscribe()

  expect(structuredAgentSessionSendsHeld(sessionId)).toBe(true)
  release()
  release()
  expect(structuredAgentSessionSendsHeld(sessionId)).toBe(false)
  expect(structuredAgentSessionsWithPendingSends()).toEqual([])
})

it('keeps a replacement created while publishing to the last listener', () => {
  const sessionId = 'replacement'
  let unsubscribe: () => void = () => undefined
  unsubscribe = watch(sessionId, () => {
    unsubscribe()
    setStructuredAgentSessionSendNotice(sessionId, 'Published during cleanup.')
  })

  publishStructuredAgentSessionSends(sessionId, { notice: null })
  expect(getStructuredAgentSessionSendNotice(sessionId)).toBe('Published during cleanup.')
})
