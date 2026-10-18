import { agentSessionFailureFact, providerDiagnostic } from '../../shared/agent-session-failure'
import {
  agentSessionFailureWords,
  type AgentSessionFailureRowWords
} from '../../shared/agent-session-failure-words'
import { BoundedMap } from '../../shared/bounded-map'
import {
  usageLimitResetsAt,
  type AgentSessionUsageLimit,
  type AgentSessionUsageLimitWindow
} from '../../shared/agent-session-usage-limit'
import { claudeRecord, claudeText } from './claude-structured-item-translation'

const CLAUDE_LIMIT_WINDOWS: Record<string, AgentSessionUsageLimitWindow> = {
  five_hour: 'session',
  seven_day: 'weekly',
  seven_day_opus: 'weeklyModel',
  seven_day_sonnet: 'weeklyModel',
  seven_day_overage_included: 'weeklyModel',
  overage: 'credits'
}

/** The ends a result reports when a limit refused its request; any other is a different failure. */
const LIMIT_TERMINAL_REASONS = ['api_error', 'blocking_limit']

export type ClaudeUsageLimitRow = AgentSessionFailureRowWords & {
  kind: 'status'
  tone: 'warning'
}

function messageText(message: Record<string, unknown>): string {
  const content = claudeRecord(message.message)?.content
  return Array.isArray(content)
    ? content
        .flatMap((part) => {
          const value = claudeRecord(part)
          return value?.type === 'text' && typeof value.text === 'string' ? [value.text] : []
        })
        .join('\n')
    : ''
}

/**
 * The account's usage limits as Claude reports them: the limit an API-error frame names
 * (`api_error: usage_limit_reached`), else a `rate_limit_event` saying a limit is `rejected` with
 * no paid usage to fall back on. Only those mean the account's own limit: the CLI shares the
 * frame's `error: rate_limit` with throttles and policy refusals that no reset clears. The CLI
 * repeats an unchanged rejection only now and then, so each one stands until a reading allows that
 * limit again or its reset passes.
 */
export class ClaudeUsageLimits {
  /** Each limit refusing requests, by Claude's name for it, with its reset (ms) if it gave one. */
  private readonly rejected = new Map<string, number | null>()
  private readonly shown = new BoundedMap<string, true>({ maxEntries: 128 })
  /** The root turn's request was refused with `rate_limit`: its failed result may be the limit. */
  private turnRefused = false

  constructor(private readonly now: () => number = Date.now) {}

  observe(message: Record<string, unknown>): void {
    if (message.type === 'rate_limit_event') {
      this.record(claudeRecord(message.rate_limit_info))
    }
  }

  /** The limit's row in place of an API-error frame the limit refused; null for any other frame. */
  assistant(message: Record<string, unknown>): ClaudeUsageLimitRow | null {
    if (message.type !== 'assistant' || message.error !== 'rate_limit') {
      return null
    }
    const named =
      message.api_error === 'usage_limit_reached'
        ? claudeRecord(claudeRecord(message.api_error_params)?.rate_limit_info)
        : null
    if (named) {
      this.record(named)
    }
    if (message.parent_tool_use_id == null) {
      this.turnRefused = true
    }
    const row = this.row(messageText(message))
    const key = row ? this.key(message) : null
    if (key) {
      this.shown.set(key, true)
    }
    return row
  }

  /** For a failed root result: the limit's row, or `shown` when its API-error frame already wrote
   *  it. Null for any other result, which keeps its own row. */
  result(message: Record<string, unknown>, failed: boolean): ClaudeUsageLimitRow | 'shown' | null {
    const refused = this.turnRefused
    this.turnRefused = false
    const key = this.key(message)
    if (key !== null && this.shown.delete(key)) {
      return failed ? 'shown' : null
    }
    const status = message.api_error_status
    const reason = claudeText(message.terminal_reason)
    const limited =
      failed &&
      (refused || reason === 'blocking_limit') &&
      (status == null || status === 429) &&
      (reason === null || LIMIT_TERMINAL_REASONS.includes(reason))
    return limited ? this.row(claudeText(message.result) ?? '') : null
  }

  private record(info: Record<string, unknown> | null): void {
    if (!info) {
      return
    }
    const type = claudeText(info.rateLimitType) ?? 'unknown'
    const overage =
      info.overageStatus === 'allowed' ||
      info.overageStatus === 'allowed_warning' ||
      info.isUsingOverage === true ||
      info.overageInUse === true
    if (info.status === 'rejected' && !overage) {
      const seconds = info.resetsAt
      const resetsAt =
        typeof seconds === 'number' ? usageLimitResetsAt(seconds * 1000, this.now()) : undefined
      this.rejected.set(type, resetsAt ?? null)
    } else if (info.status === 'allowed' || info.status === 'allowed_warning' || overage) {
      this.rejected.delete(type)
    }
  }

  /** Every refusing limit must reset before a request can run, so the latest reset is the one. */
  private limit(): AgentSessionUsageLimit | null {
    const now = this.now()
    for (const [type, resetsAt] of this.rejected) {
      if (resetsAt !== null && resetsAt <= now) {
        this.rejected.delete(type)
      }
    }
    if (this.rejected.size === 0) {
      return null
    }
    const windows = new Set([...this.rejected.keys()].map((type) => CLAUDE_LIMIT_WINDOWS[type]))
    const window = windows.size === 1 ? [...windows][0] : undefined
    const resets = [...this.rejected.values()].filter((reset): reset is number => reset !== null)
    const resetsAt = resets.length === this.rejected.size ? Math.max(...resets) : undefined
    return { ...(window ? { window } : {}), ...(resetsAt ? { resetsAt } : {}) }
  }

  private row(providerText: string): ClaudeUsageLimitRow | null {
    const limit = this.limit()
    if (!limit) {
      return null
    }
    return {
      kind: 'status',
      tone: 'warning',
      ...agentSessionFailureWords(
        agentSessionFailureFact('usageLimitReached', {
          ...(limit.window || limit.resetsAt ? { usageLimit: limit } : {}),
          detail: providerDiagnostic(providerText, 'person')
        }),
        { agentName: 'Claude', provider: 'claude', surface: 'row' }
      )
    }
  }

  private key(message: Record<string, unknown>): string | null {
    const uuid = claudeText(message.user_message_uuid)
    return uuid
      ? JSON.stringify([message.session_id, message.parent_tool_use_id ?? null, uuid])
      : null
  }
}
