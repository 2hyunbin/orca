import { describe, expect, it } from 'vitest'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'

const RESETS_AT_S = Math.floor(Date.now() / 1000) + 3 * 24 * 3600
const CODEX_WORDS = "You've hit your usage limit. Try again in 3 days."

function translatorWithRows() {
  const bodies: AgentJournalItemBody[] = []
  const translator = createCodexJournalTranslator({
    primaryThreadId: () => 'thread',
    sink: {
      appendItem: (_identity, body) => bodies.push(body),
      appendTombstone: () => {},
      publish: () => {}
    }
  })
  const notify = (method: string, params: Record<string, unknown>) =>
    translator.handle({
      type: 'notification',
      sessionId: 'session',
      threadId: 'thread',
      method,
      params
    })
  return { bodies, translator, notify }
}

describe('a Codex usage limit', () => {
  it('names the spent window and its reset from the last usage report', () => {
    const { bodies, translator, notify } = translatorWithRows()
    notify('account/rateLimits/updated', {
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: RESETS_AT_S - 3600 },
        secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: RESETS_AT_S }
      }
    })
    // An update may carry only what changed; the spent weekly window still stands.
    notify('account/rateLimits/updated', {
      rateLimits: {
        primary: { usedPercent: 41, windowDurationMins: 300, resetsAt: RESETS_AT_S - 3600 }
      }
    })
    notify('error', {
      threadId: 'thread',
      turnId: 'turn',
      willRetry: false,
      error: { codexErrorInfo: 'usageLimitExceeded', message: CODEX_WORDS }
    })

    expect(bodies.filter((body) => body.kind === 'status')).toEqual([
      expect.objectContaining({
        tone: 'warning',
        text: 'Codex hit its weekly limit. Send a message once it resets to continue.',
        failure: {
          kind: 'usageLimitReached',
          usageLimit: { window: 'weekly', resetsAt: RESETS_AT_S * 1000 },
          detail: { text: CODEX_WORDS, audience: 'person' }
        }
      })
    ])
    translator.dispose()
  })
})
