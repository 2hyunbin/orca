import { join } from 'node:path'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { runHistoryCatchUp } from '../native-chat/agent-session-wire/structured-agent-session-history-catch-up'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import { createClaudeTranscriptImportPlan } from './claude-transcript-import-plan'
import { readClaudeTranscriptTail } from './claude-transcript-tail'

const DEFAULT_CLAUDE_CATCH_UP_TIMEOUT_MS = 30_000

// A chat's turn-end leaf is the newest transcript row it has shown. Anything Claude wrote after it
// came from another process on the same conversation (a terminal `claude --resume`), or from this
// chat's own turn cut off before its end was recorded; rows the chat already holds are skipped.

/** Display only and optional: it never settles a send and never gates opening. */
export async function catchUpClaudeTranscript(input: {
  sessionId: string
  providerSessionId: string
  leafUuid: string
  claudeConfigDir: string
  sink: StructuredAgentSessionEventSink
  signal?: AbortSignal
  assertCurrent?: () => void
  timeoutMs?: number
  logger?: StructuredAgentSessionLogger
}): Promise<void> {
  await runHistoryCatchUp({
    agentName: 'Claude',
    scope: 'claude-transcript-catch-up',
    sessionId: input.sessionId,
    sink: input.sink,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.assertCurrent ? { assertCurrent: input.assertCurrent } : {}),
    timeoutMs: input.timeoutMs ?? DEFAULT_CLAUDE_CATCH_UP_TIMEOUT_MS,
    ...(input.logger ? { logger: input.logger } : {}),
    // Rows the chat holds are matched one by one at planning and again at commit; only whether
    // there are any (for the divider) is read up front.
    readView: (history) => {
      let hasRows = false
      history.visitItems(() => {
        hasRows = true
      })
      return { hasRows }
    },
    sameView: (planned, current) => planned.hasRows === current.hasRows,
    prepare: async ({ view, journal, check, yieldTurn, warn }) => {
      const filePath = await resolveSessionFilePath('claude', input.providerSessionId, {
        claudeProjectsDir: join(input.claudeConfigDir, 'projects')
      })
      if (!filePath) {
        return null
      }
      const tail = await readClaudeTranscriptTail({ filePath, leafUuid: input.leafUuid, check })
      if (!tail) {
        warn('leaf-not-in-tail')
        return null
      }
      if (tail.rows.length === 0) {
        return null
      }
      const staging = createClaudeTranscriptImportPlan({
        sessionId: input.sessionId,
        providerSessionId: input.providerSessionId,
        journal,
        rewound: view.hasRows ? tail.rewound : null,
        check
      })
      try {
        for (const row of tail.rows) {
          staging.restore(row)
          await yieldTurn()
        }
        return staging.finish()
      } finally {
        staging.dispose()
      }
    }
  })
}
