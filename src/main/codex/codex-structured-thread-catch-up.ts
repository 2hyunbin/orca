import type { AgentJournalItemIdentity } from '../../shared/agent-session-journal-types'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import {
  continuedOutsideNotice,
  runHistoryCatchUp
} from '../native-chat/agent-session-wire/structured-agent-session-history-catch-up'
import {
  DEFAULT_CODEX_REQUEST_TIMEOUT_MS,
  type CodexAppServerConnection
} from './codex-app-server-connection'
import { createCodexHistoryImportPlan } from './codex-history-import-plan'
import { discoverCodexHistory, loadCodexHistory } from './codex-structured-thread-history-pages'
import {
  readCodexHistoryJournalView,
  sameCodexHistoryJournalView
} from './codex-history-journal-view'

// A chat writes its conversation only while its own app-server holds Codex's writer lock, so turns
// made anywhere else land only while the chat has no process; every process start opens here.

/** Optional reconciliation never gates provider open; an abandoned invocation cannot later write. */
export async function catchUpCodexThread(input: {
  connection: Pick<CodexAppServerConnection, 'request'>
  threadId: string
  sessionId: string
  sink: StructuredAgentSessionEventSink
  signal?: AbortSignal
  assertCurrent?: () => void
  timeoutMs?: number
  logger?: StructuredAgentSessionLogger
  onReceipt?: (
    clientMessageId: string,
    providerIdentity: AgentJournalItemIdentity
  ) => void | Promise<void>
}): Promise<void> {
  const deadline = Date.now() + (input.timeoutMs ?? DEFAULT_CODEX_REQUEST_TIMEOUT_MS)
  let receipts: ReturnType<ReturnType<typeof createCodexHistoryImportPlan>['finish']>['receipts'] =
    []
  const outcome = await runHistoryCatchUp({
    agentName: 'Codex',
    scope: 'codex-thread-catch-up',
    sessionId: input.sessionId,
    sink: input.sink,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.assertCurrent ? { assertCurrent: input.assertCurrent } : {}),
    timeoutMs: input.timeoutMs ?? DEFAULT_CODEX_REQUEST_TIMEOUT_MS,
    ...(input.logger ? { logger: input.logger } : {}),
    readView: (history) => readCodexHistoryJournalView(history, input.threadId),
    sameView: sameCodexHistoryJournalView,
    prepare: async ({ view: readView, journal, signal, deadline, check, yieldTurn }) => {
      const view = readView()
      const read = {
        connection: input.connection,
        threadId: input.threadId,
        signal,
        deadline,
        check
      }
      const missing = await discoverCodexHistory(read, view)
      if (missing.pages.length === 0) {
        return null
      }
      const staging = createCodexHistoryImportPlan({
        sessionId: input.sessionId,
        threadId: input.threadId,
        journal,
        nativePromptKeys: view.nativePromptKeys,
        outsideNotice: view.hasRows ? continuedOutsideNotice(missing.rewound) : undefined,
        check
      })
      try {
        for await (const turn of loadCodexHistory(read, missing.pages)) {
          check()
          if (typeof turn.id === 'string' && view.known.has(turn.id)) {
            staging.confirmReceipts(turn)
          } else {
            staging.restore(turn)
          }
          await yieldTurn()
        }
        const plan = staging.finish()
        receipts = plan.receipts
        return plan
      } finally {
        staging.dispose()
      }
    }
  })
  if (outcome === 'committed' || outcome === 'checked') {
    const signal = AbortSignal.any([
      ...(input.signal ? [input.signal] : []),
      AbortSignal.timeout(Math.max(1, deadline - Date.now()))
    ])
    try {
      signal.throwIfAborted()
      input.assertCurrent?.()
      await waitForPromiseWithSignal(
        Promise.all(
          receipts.map(async (receipt) =>
            input.onReceipt?.(receipt.clientMessageId, receipt.providerIdentity)
          )
        ),
        signal
      )
    } catch (error) {
      input.logger?.warn('Codex replay receipt settlement did not finish within open', {
        scope: 'codex-thread-catch-up',
        sessionId: input.sessionId,
        error
      })
    }
  }
}
