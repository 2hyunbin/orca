import { expect, it, vi } from 'vitest'
import type {
  AgentJournalSnapshot,
  AgentJournalItemBody
} from '../../../shared/agent-session-journal-types'
import { agentSessionRecordFixture } from '../../../shared/agent-session-record.test-fixture'
import { readStructuredSessionRecovery } from './structured-agent-session-recovery-read'
const prepare = vi.hoisted(() => vi.fn())
vi.mock('../../runtime/structured-session-recovery-options', () => ({
  structuredSessionRecoveryOptions: prepare
}))

it('does no discovery on ordinary reads and drops preparation superseded by a send', async () => {
  const record = agentSessionRecordFixture()
  const snapshot: AgentJournalSnapshot = {
    sessionId: record.sessionId,
    cursor: { epoch: 'epoch', sequence: 1 },
    items: [],
    submissions: []
  }
  const session = { journal: { snapshot: () => snapshot } }
  const deps = {
    store: { getRecord: () => record },
    journalDatabase: { stateDirectory: '/state' },
    resolveLaunchEnv: vi.fn(() => ({}))
  }
  const context = { deps, conversation: async () => session }
  expect(await readStructuredSessionRecovery(session, context, record.sessionId)).toEqual({
    canSwitchAccount: false
  })
  expect(prepare).not.toHaveBeenCalled()
  expect(deps.resolveLaunchEnv).not.toHaveBeenCalled()
  const bodies: AgentJournalItemBody[] = [
    {
      kind: 'turn',
      turnId: 'turn',
      state: 'completed',
      outcome: 'failure',
      startedAt: 1,
      completedAt: 2
    },
    { kind: 'status', text: 'limited', failure: { kind: 'usageLimitReached' } }
  ]
  snapshot.items = bodies.map((body, sequence) => ({
    itemId: sequence ? 'limit' : 'turn',
    sequence,
    revision: 1,
    observedAt: 1,
    body,
    ...(sequence ? { turnScope: { kind: 'turn' as const, turnItemId: 'turn' } } : {})
  }))
  const preparation = Promise.withResolvers<{ canSwitchAccount: boolean; transcriptPath: string }>()
  prepare.mockReturnValue(preparation.promise)
  const pending = readStructuredSessionRecovery(session, context, record.sessionId)
  await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce())
  snapshot.items = []
  preparation.resolve({ canSwitchAccount: true, transcriptPath: '/old-context' })
  expect(await pending).toEqual({ canSwitchAccount: false })
})
