import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import type * as StructuredSessionMailTarget from '../structured-session-mail-target'

vi.mock('../structured-session-mail-target', async (importOriginal) => ({
  ...(await importOriginal<typeof StructuredSessionMailTarget>()),
  structuredSessionIdleEdgeMailboxes: () => ['term_mailbox']
}))

describe('mail dispatch through the current runtime', () => {
  it('uses runtime journal and delivery overrides on the idle edge', () => {
    const target = new OrcaRuntimeService()
    const events: string[] = []
    Object.defineProperties(target, {
      notifyStructuredSessionJournalActivity: {
        value: function (this: OrcaRuntimeService, sessionId: string) {
          expect(this).toBe(target)
          expect(arguments.length).toBe(1)
          events.push(`journal:${sessionId}`)
        }
      },
      deliverPendingMessagesForHandle: {
        value: function (this: OrcaRuntimeService, handle: string) {
          expect(this).toBe(target)
          expect(arguments.length).toBe(1)
          events.push(`delivery:${handle}`)
        }
      }
    })

    target.onStructuredSessionStatusForMail({ sessionId: 'session-mailbox', status: 'working' })
    expect(events).toEqual([])
    target.onStructuredSessionStatusForMail({ sessionId: 'session-mailbox', status: 'idle' })
    expect(events).toEqual(['journal:session-mailbox', 'delivery:term_mailbox'])
  })

  it('uses the runtime delivery override during repoint repair', () => {
    const target = new OrcaRuntimeService()
    const delivery = vi.fn(function (this: OrcaRuntimeService, handle: string) {
      expect(this).toBe(target)
      expect(arguments.length).toBe(1)
      expect(handle).toBe('term_mailbox')
    })
    Object.defineProperty(target, 'deliverPendingMessagesForHandle', { value: delivery })

    target['repointPendingMessagesForHandle']('term_mailbox')
    expect(delivery).toHaveBeenCalledOnce()
  })

  it('uses runtime coordinator and direct worker target overrides', () => {
    const target = new OrcaRuntimeService()
    Object.defineProperties(target, {
      resolveStructuredCoordinatorMailboxTarget: {
        value: function (this: OrcaRuntimeService, runId: string) {
          expect(this).toBe(target)
          expect(arguments.length).toBe(1)
          expect(runId).toBe('run-mailbox')
          return { sessionId: 'coordinator-session', dispatchId: null }
        }
      },
      resolveStructuredWorkerDirectMailboxTarget: {
        value: function (this: OrcaRuntimeService, handle: string) {
          expect(this).toBe(target)
          expect(arguments.length).toBe(1)
          expect(handle).toBe('term_mailbox')
          return { sessionId: 'worker-session', dispatchId: null }
        }
      }
    })

    expect(target['resolveStructuredMailboxTarget']('run:run-mailbox')).toEqual({
      sessionId: 'coordinator-session',
      dispatchId: null
    })
    expect(target['resolveStructuredMailboxTarget']('term_mailbox')).toEqual({
      sessionId: 'worker-session',
      dispatchId: null
    })
  })
})
