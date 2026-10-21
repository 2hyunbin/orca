import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { agentSessionHostStatusBody } from '../../shared/agent-session-host-status-rows'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
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
  const controller = new AbortController()
  const abort = () => controller.abort(input.signal?.reason)
  input.signal?.addEventListener('abort', abort, { once: true })
  if (input.signal?.aborted) {
    abort()
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_CLAUDE_CATCH_UP_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs
  const timer = setTimeout(() => controller.abort(new Error('catch-up-deadline')), timeoutMs)
  const check = () => {
    if (controller.signal.aborted || Date.now() >= deadline) {
      throw new Error('catch-up-cancelled')
    }
    input.assertCurrent?.()
  }
  const warn = (reason: string, error?: unknown) =>
    input.logger?.warn('Claude chat did not catch up on turns made outside it', {
      scope: 'claude-transcript-catch-up',
      sessionId: input.sessionId,
      reason,
      ...(error === undefined ? {} : { error })
    })
  let staging: ReturnType<typeof createClaudeTranscriptImportPlan> | undefined
  try {
    check()
    const filePath = await resolveSessionFilePath('claude', input.providerSessionId, {
      claudeProjectsDir: join(input.claudeConfigDir, 'projects')
    })
    if (!filePath) {
      return
    }
    const tail = await waitForPromiseWithSignal(
      readClaudeTranscriptTail({ filePath, leafUuid: input.leafUuid, check }),
      controller.signal
    )
    if (!tail) {
      warn('leaf-not-in-tail')
      return
    }
    if (tail.rows.length === 0) {
      return
    }
    const written = await waitForPromiseWithSignal(
      input.sink.written?.() ?? Promise.resolve({ ok: true }),
      controller.signal
    )
    check()
    const journal = input.sink.journalItems?.()
    if (!journal || !written.ok || !input.sink.tryAppendTransition) {
      return
    }
    const epoch = journal.epoch
    let hasRows = false
    journal.visitItems(() => {
      hasRows = true
    })
    staging = createClaudeTranscriptImportPlan({
      sessionId: input.sessionId,
      providerSessionId: input.providerSessionId,
      journal,
      outsideNotice: hasRows
        ? agentSessionHostStatusBody(
            tail.rewound ? 'continued-outside-rewound' : 'continued-outside'
          )
        : undefined,
      check
    })
    for (const row of tail.rows) {
      staging.restore(row)
      await setImmediate()
    }
    const plan = staging.finish()
    if (plan.mutations.length === 0) {
      return
    }
    let resolved = false
    const admission = input.sink.tryAppendTransition({
      lifecycle: true,
      publish: true,
      steps: [
        {
          kind: 'settlement',
          settlementId: plan.settlementId,
          reservedBytes: plan.reservedBytes,
          resolve: (current) => {
            try {
              check()
            } catch {
              return []
            }
            // Anything the chat wrote since the plan was read may be one of these rows.
            if (
              current.epoch !== epoch ||
              input.sink.journalItems?.() !== journal ||
              plan.keys.some((key) => current.item(current.canonicalItemId(key)) !== null) ||
              new Set(plan.keys.map((key) => current.canonicalItemId(key))).size !==
                plan.keys.length
            ) {
              return []
            }
            resolved = true
            return plan.mutations
          }
        }
      ]
    })
    if (!admission.accepted) {
      warn(admission.reason)
      return
    }
    const committed = await input.sink.written?.()
    if (committed?.ok === false) {
      warn('write-failed', committed.error)
    } else if (!resolved) {
      warn('stale-history')
    }
  } catch (error) {
    warn('import-skipped', error)
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener('abort', abort)
    staging?.dispose()
  }
}
