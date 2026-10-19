// What the picker shows for a chat's speed is what its next turn runs, on any host's answer.

import { describe, expect, it, vi } from 'vitest'
import { CODEX_SESSION_OPTION_CATALOG } from '../../shared/agent-session-option-catalog-claude-codex'
import {
  applyStructuredAgentSessionOptions,
  commitStructuredAgentSessionOption,
  commitStructuredAgentSessionOptionReply,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionSnapshot,
  type StructuredAgentSessionOptionState
} from '../../shared/structured-agent-session-options'
import { AgentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { CodexAcquisitionWindow } from './codex-structured-acquisition-window'
import { CodexBackgroundTaskTracker } from './codex-background-task-tracker'
import { createCodexDispatchEchoes } from './codex-structured-dispatch-echo'
import { createCodexTurnOpenWaits } from './codex-structured-turn-open-wait'
import type { CodexSession } from './codex-structured-session-state'
import { startCodexTurn } from './codex-structured-turn-start'

const tiers = (...values: string[]) => values.map((value) => ({ value, label: value }))
// M1 offers Fast and Flex; M2 offers only Ultrafast.
const MODELS = [
  { id: 'm1', label: 'M1', isDefault: true, efforts: [], serviceTiers: tiers('priority', 'flex') },
  { id: 'm2', label: 'M2', isDefault: false, efforts: [], serviceTiers: tiers('ultrafast') }
]

/** The tier the first turn after a start carries for the chat's saved options. */
async function firstTurnTier(saved: Record<string, string>): Promise<unknown> {
  const store = new AgentModelCatalogStore()
  store.recordSuccess('codex-account', 'codex', { models: MODELS, origin: 'probe' }, 'discovery')
  const request = vi.fn(async (_method: string, _params?: Record<string, unknown>) => ({
    turn: { id: 'turn-1' }
  }))
  const session: CodexSession = {
    connection: {
      pid: 1,
      closed: false,
      request,
      notify: () => {},
      respond: () => {},
      respondWithError: () => {},
      close: async () => true
    },
    backgroundTasks: new CodexBackgroundTaskTracker('thread-1'),
    ended: false,
    fence: 1,
    acquisitionGeneration: 'generation-1',
    threadId: 'thread-1',
    prompts: new CodexAcquisitionWindow().prompts,
    options: new Map(Object.entries(saved)),
    reportedOptions: {},
    catalogAccess: { store, fingerprint: 'codex-account', accountHomePath: '/account' },
    dispatchEchoes: createCodexDispatchEchoes(),
    turnOpenWaits: createCodexTurnOpenWaits(),
    translator: null
  }
  await startCodexTurn(session, {
    clientMessageId: 'message-1',
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'go' }] }
  })
  return request.mock.calls.find(([method]) => method === 'turn/start')?.[1]?.serviceTier
}

/** An older host's answer at rest: the saved values, with no defaults marked. */
function atRest(saved: Record<string, string>): StructuredAgentSessionOptionState {
  return applyStructuredAgentSessionOptions(
    createStructuredAgentSessionOptionState('codex', CODEX_SESSION_OPTION_CATALOG),
    CODEX_SESSION_OPTION_CATALOG,
    { models: MODELS, current: saved }
  )
}

function shownTier(state: StructuredAgentSessionOptionState): string | undefined {
  const kind = structuredAgentSessionOptionSnapshot(state).find(
    (entry) => entry.id === 'serviceTier'
  )?.kind
  return kind?.type === 'select' ? kind.currentValue : undefined
}

describe("a Codex chat's speed, shown and sent", () => {
  it('shows what the first turn runs, and keeps the saved tier for a model that offers it', async () => {
    // Codex runs a tier the model lacks as Standard, but passes Flex regardless.
    for (const [saved, runs] of [
      [{ model: 'm2', serviceTier: 'priority' }, 'default'],
      [{ model: 'm2', serviceTier: 'flex' }, 'flex'],
      [{ model: 'm1', serviceTier: 'priority' }, 'priority']
    ] as const) {
      expect(shownTier(atRest(saved))).toBe(runs)
      await expect(firstTurnTier(saved)).resolves.toBe(runs)
    }
    // Back on a model that offers it, the saved tier is the chat's again.
    const back = commitStructuredAgentSessionOption(
      atRest({ model: 'm2', serviceTier: 'priority' }),
      'model',
      'm1'
    )
    expect(shownTier(back)).toBe('priority')
  })

  it('asserts no Flex after a model pick the host has not answered, until its reply', () => {
    const picked = commitStructuredAgentSessionOption(
      atRest({ model: 'm1', serviceTier: 'flex' }),
      'model',
      'm2'
    )
    expect(shownTier(picked)).toBeUndefined()
    // At rest the host saves the pick beside the chat's Flex, which the next start passes.
    const answered = commitStructuredAgentSessionOptionReply(picked, {
      model: 'm2',
      serviceTier: 'flex'
    })
    expect(shownTier(answered)).toBe('flex')
  })
})
