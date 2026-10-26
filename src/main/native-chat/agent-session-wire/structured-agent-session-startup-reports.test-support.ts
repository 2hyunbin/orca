import { describe, expect, it, type Mock } from 'vitest'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION
} from './structured-agent-session-host-test-data'

type StartupReportsFixture = {
  host: StructuredAgentSessionHost
  store: AgentSessionRecordStore
  acquire: Mock<StructuredAgentSessionAdapter['acquire']>
  restartWith: (next: StructuredAgentSessionAdapter['acquire']) => Promise<void>
  publishFirst: StructuredAgentSessionAdapter['acquire']
  heldBehindStart: (text: string) => Promise<string>
  proveOpen: (model?: string) => Promise<void>
  eventually: (assertion: () => void | Promise<void>) => Promise<void>
  submission: (id: string) => Promise<AgentJournalSubmission | undefined>
  recordLiveListing: Mock
}

export function registerStartupReports(fixture: StartupReportsFixture): void {
  describe('what a started child reports', () => {
    it('keeps provider reports out of the saved next-message choice', async () => {
      await fixture.restartWith(fixture.publishFirst)
      const id = await fixture.heldBehindStart('hello')
      await fixture.proveOpen('reported')
      await fixture.eventually(async () =>
        expect((await fixture.submission(id))?.dispatchState).toBe('accepted')
      )
      await fixture.host.handleAdapterEvent({
        type: 'options-reported',
        sessionId: SESSION,
        fence: fixture.store.getRecord(SESSION)!.lease.runtimeFence,
        acquisitionGeneration: `generation-${fixture.acquire.mock.calls.length}`,
        reportedOptions: { model: 'from-settings' }
      })
      await fixture.host.flushStreamedEvents(SESSION)
      expect(fixture.store.getRecord(SESSION)?.options).toBeUndefined()
    })

    it('preserves a later accepted pick when an older child reports options', async () => {
      await fixture.restartWith(fixture.publishFirst)
      const id = await fixture.heldBehindStart('hello')
      await fixture.store.replaceSessionOptions({
        sessionId: SESSION,
        fence: fixture.store.getRecord(SESSION)!.lease.runtimeFence,
        options: { model: 'picked' },
        now: NOW
      })
      await fixture.proveOpen('reported')
      await fixture.eventually(async () =>
        expect((await fixture.submission(id))?.dispatchState).toBe('accepted')
      )
      await fixture.host.handleAdapterEvent({
        type: 'options-reported',
        sessionId: SESSION,
        fence: fixture.store.getRecord(SESSION)!.lease.runtimeFence,
        acquisitionGeneration: `generation-${fixture.acquire.mock.calls.length}`,
        reportedOptions: { model: 'from-settings' }
      })
      await fixture.host.flushStreamedEvents(SESSION)
      expect(fixture.store.getRecord(SESSION)?.options).toEqual({ model: 'picked' })
    })

    it('saves a settings readback that arrives before open proves the start', async () => {
      await fixture.restartWith(fixture.publishFirst)
      await fixture.heldBehindStart('hello')
      const listing = { models: [], configuredDefault: { modelId: 'opus' } }
      const reported = fixture.host.handleAdapterEvent({
        type: 'options-reported',
        sessionId: SESSION,
        fence: fixture.store.getRecord(SESSION)!.lease.runtimeFence,
        acquisitionGeneration: `generation-${fixture.acquire.mock.calls.length}`,
        reportedOptions: { model: 'opus' },
        catalogListing: listing
      })
      await fixture.proveOpen()
      await reported

      await fixture.eventually(() =>
        expect(fixture.recordLiveListing).toHaveBeenCalledWith(SESSION, listing)
      )
    })
  })
}
