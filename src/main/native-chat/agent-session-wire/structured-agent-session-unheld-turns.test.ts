import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import { settleUnheldStructuredAgentSessionTurns } from './structured-agent-session-unheld-turns'

const PROVIDER_SESSION = '819cf9f8-e43c-4ad7-b50f-54aa158a726a'
const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  hostId: 'host-1',
  agent: 'claude',
  providerHandle: claudeProviderHandle(PROVIDER_SESSION, null)
}
const EARLIER = 3
const LIVE = 4

const journals = createTrackedJournalOpener()
let root: string | null = null

afterEach(async () => {
  await journals.closeAll()
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = null
  }
})

async function chatWithRunningTurns() {
  root = await mkdtemp(join(tmpdir(), 'orca-unheld-turns-'))
  const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
  const turn = (turnId: string, fence: number) =>
    journal.appendItem(
      { provider: 'claude', sessionId: PROVIDER_SESSION, uuid: turnId },
      { kind: 'turn', turnId, state: 'running', startedAt: fence },
      { fence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  const earlier = await turn('earlier-child', EARLIER)
  const restored = await turn('restored', LIVE)
  const live = await turn('live', LIVE)
  const state = (itemId: string) => {
    const body = journal.item(itemId)?.body
    return body?.kind === 'turn' ? body.state : null
  }
  return { journal, earlier, restored, live, state }
}

describe('turns the live child is not running', () => {
  it('ends a restored running turn once and keeps the child’s own turn running', async () => {
    const { journal, earlier, restored, live, state } = await chatWithRunningTurns()
    await settleUnheldStructuredAgentSessionTurns(journal, 'session-1', LIVE, 'g-1', 'live')
    expect(state(restored.itemId)).toBe('interrupted')
    expect(state(live.itemId)).toBe('running')
    // Earlier children are the attach sweep's; this never reads another fence.
    expect(state(earlier.itemId)).toBe('running')
    const cursor = journal.cursor()
    await settleUnheldStructuredAgentSessionTurns(journal, 'session-1', LIVE, 'g-1', 'live')
    expect(journal.cursor()).toEqual(cursor)
  })

  it('settles nothing when the agent cannot say what it is running', async () => {
    const { journal, restored, state } = await chatWithRunningTurns()
    await settleUnheldStructuredAgentSessionTurns(journal, 'session-1', LIVE, 'g-1', undefined)
    expect(state(restored.itemId)).toBe('running')
  })
})
