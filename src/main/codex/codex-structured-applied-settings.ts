import { throwIfSignalAborted, waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { AGENT_SESSION_GOAL_CONTROL_COPY } from '../../shared/agent-session-goal-control-copy'
import { isCodexAppServerUnsupportedError } from './codex-app-server-session'
import { readRecord } from './codex-item-field-readers'
import { isCodexAppServerRequestError } from './app-server/codex-app-server-request-error'
import type { CodexAppServerConnection } from './app-server/codex-app-server-connection-types'

type Settings = { model?: string; effort?: string | null }

/** Only explicit method declarations permit compatibility fallback. */
export function codexMethodUnavailable(error: unknown, method: string): boolean {
  if (
    isCodexAppServerUnsupportedError(error) &&
    error instanceof Error &&
    error.message.includes(method)
  ) {
    return true
  }
  return (
    isCodexAppServerRequestError(error) &&
    (error.code === -32601 ||
      (error.message.includes(method) &&
        /(?:method|capability).*(?:unavailable|unsupported|not found)/i.test(error.message)))
  )
}

/** Receipt-level evidence must not wait behind the host mutation that needs it. */
export class CodexAppliedSettings {
  private snapshot: Settings = {}
  private readonly pending = new Set<Settings>()
  private readonly listeners = new Set<() => void>()
  private ended = false
  private unsupported = false

  observe(value: unknown): void {
    const row = readRecord(value)
    this.snapshot = {
      ...(typeof row.model === 'string' ? { model: row.model } : {}),
      ...(typeof row.effort === 'string' || row.effort === null ? { effort: row.effort } : {})
    }
    for (const write of this.pending) {
      if (
        (['model', 'effort'] as const).every(
          (key) => write[key] === undefined || write[key] === this.snapshot[key]
        )
      ) {
        this.pending.delete(write)
      }
    }
    for (const listener of this.listeners) {
      listener()
    }
  }

  end(): void {
    this.ended = true
    this.snapshot = {}
    this.pending.clear()
    for (const listener of this.listeners) {
      listener()
    }
  }

  attempt(choices: Settings): () => void {
    if (this.equivalent(choices)) {
      return () => {}
    }
    this.pending.add(choices)
    return () => this.pending.delete(choices)
  }

  private equivalent(choices: Settings): boolean {
    return (['model', 'effort'] as const).every(
      (key) =>
        choices[key] === undefined ||
        (choices[key] === this.snapshot[key] &&
          ![...this.pending].some(
            (write) => write[key] !== undefined && write[key] !== choices[key]
          ))
    )
  }

  async install(
    connection: CodexAppServerConnection,
    threadId: string,
    choices: Settings,
    timeoutMs = 30_000,
    signal?: AbortSignal
  ): Promise<{ ok: true } | { ok: false; rejected: string }> {
    throwIfSignalAborted(signal)
    if (this.unsupported || this.equivalent(choices)) {
      return { ok: true }
    }
    const deadline = Date.now() + timeoutMs
    const changed = Promise.withResolvers<void>()
    const check = () => {
      if (this.ended) {
        expired.reject(new Error('codex settings connection ended'))
      } else if (this.equivalent(choices)) {
        changed.resolve()
      }
    }
    void changed.promise.catch(() => {})
    this.listeners.add(check)
    const discard = this.attempt(choices)
    const expired = Promise.withResolvers<never>()
    const timer = setTimeout(
      () => expired.reject(new Error('codex settings application timed out')),
      timeoutMs
    )
    let rejected = false
    try {
      const work = (async () => {
        try {
          await connection.request(
            'thread/settings/update',
            { threadId, ...choices },
            {
              timeoutMs: Math.max(1, deadline - Date.now())
            }
          )
        } catch (error) {
          if (
            isCodexAppServerRequestError(error) ||
            codexMethodUnavailable(error, 'thread/settings/update')
          ) {
            discard()
            if (codexMethodUnavailable(error, 'thread/settings/update')) {
              this.unsupported = true
              return
            }
            rejected = true
          }
          throw error
        }
        check()
        await changed.promise
      })()
      await waitForPromiseWithSignal(Promise.race([work, expired.promise]), signal)
      return { ok: true }
    } catch {
      throwIfSignalAborted(signal)
      return {
        ok: false,
        rejected: rejected
          ? AGENT_SESSION_GOAL_CONTROL_COPY.settingsRejected
          : AGENT_SESSION_GOAL_CONTROL_COPY.settingsUnconfirmed
      }
    } finally {
      clearTimeout(timer)
      this.listeners.delete(check)
      changed.reject(new Error('codex settings wait ended'))
    }
  }
}
