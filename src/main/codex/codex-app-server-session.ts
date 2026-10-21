import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawnManagedProviderProcess } from '../provider-process/managed-provider-process'
import { resolveProviderChildEnv } from '../provider-process/provider-process-launch'
import { stderrIndicatesMissingAppServer } from './codex-app-server-capability-signal'
import { withCliRuntimeOnPath } from '../../shared/node-cli-command-resolution'
import {
  killCodexAppServerProcessTree,
  spawnCodexAppServerProcess,
  type CodexAppServerSpawn
} from './codex-app-server-process-tree-kill'
import { createProviderRecordReader } from '../provider-process/provider-record-reader'

// Why: `codex app-server` is Orca's sanctioned RPC surface into Codex-owned
// state (hook trust hashes, the sqlite thread index). This module owns the
// stdio JSONL transport — spawn, handshake, framing, deadline, reap — so every
// RPC consumer (trust grant, session index heal) shares one hardened lifecycle.

export type CodexAppServerInvocation = {
  command: string
  args: string[]
  cwd?: string
  /**
   * The resolved CLI path, used to pair the CLI with the `node` it was installed
   * against — without it a CLI resolved out of a version-manager directory runs
   * under whatever node leads PATH and dies on a NODE_MODULE_VERSION mismatch
   * (stablyai/orca#10932).
   *
   * Required, and `null` only for a guest-side launcher (wsl.exe) where the host
   * path means nothing. Optional would let a native builder omit it and silently
   * skip the pairing with no type error.
   */
  cliPath: string | null
  /** Overlay applied on top of the inherited environment (e.g. CODEX_HOME). */
  env?: Record<string, string>
  /** Env keys stripped from the inherited environment before spawn (e.g. an inherited
   *  CODEX_HOME, so `listCodexHooks` with no `codexHome` lists the real ~/.codex). */
  envToDelete?: readonly string[]
  /** Whole-session deadline. The codex child is stopped when it lapses. */
  timeoutMs: number
  /** Stops the session and its child early, as the deadline would. */
  signal?: AbortSignal
  /** Kill the whole tree while the root still lives, before ending its stdin. For a session that
   *  lets Codex start plugin work: an unsupervised root that exits on stdin end leaves its git
   *  children behind, and a tree kill after the root exits is refused. */
  treeKillOnFinish?: boolean
}

/** Codex-side absence of the requested app-server RPC surface (old CLI without
 *  the app-server subcommand, or a server without the called methods).
 *  This is the ONLY error class capability caches mark unsupported. */
export class CodexAppServerUnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodexAppServerUnsupportedError'
  }
}

export class CodexAppServerTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodexAppServerTimeoutError'
  }
}

export function isCodexAppServerUnsupportedError(error: unknown): boolean {
  return error instanceof Error && error.name === 'CodexAppServerUnsupportedError'
}

type JsonRpcResponse = {
  id?: number
  result?: unknown
  error?: { code?: number; message?: string }
}

export type CodexAppServerRpc = {
  /** `timeoutMs` bounds one call inside the session deadline, so a caller can drop it and go on;
   *  absent or null, only the session deadline does. */
  request: (
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number | null }
  ) => Promise<unknown>
  notify: (method: string, params?: Record<string, unknown>) => void
}

const JSON_RPC_METHOD_NOT_FOUND = -32601
const STDERR_DETAIL_MAX_CHARS = 400
const CODEX_APP_SERVER_KILL_SITE = 'codex-app-server-session'

/** Codex answering "no such method" is the only response that proves the RPC
 *  surface is absent rather than temporarily failing. */
export function isCodexMethodNotFoundError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false
  }
  const { code, message } = error as { code?: unknown; message?: unknown }
  return (
    code === JSON_RPC_METHOD_NOT_FOUND ||
    /method not found/i.test(typeof message === 'string' ? message : '')
  )
}

/**
 * Runs one short-lived `codex app-server` session over stdio JSON-RPC (JSONL):
 * spawn → initialize → initialized → body(rpc) → EOF/reap. The child is reaped
 * on every path; the session deadline stops it. The execution host owns its POSIX group.
 */
export async function runCodexAppServerSession<T>(
  invocation: CodexAppServerInvocation,
  body: (rpc: CodexAppServerRpc) => Promise<T>,
  spawnImpl: CodexAppServerSpawn = spawnCodexAppServerProcess
): Promise<T> {
  // Why: a default-home grant must run against the real ~/.codex, so strip an
  // inherited CODEX_HOME (envToDelete) after applying the overlay, not before.
  const childEnv = resolveProviderChildEnv(invocation, process.env)
  const pairedEnv = invocation.cliPath
    ? withCliRuntimeOnPath(invocation.cliPath, childEnv)
    : childEnv
  // The Codex connection's managed process and close policy, so a session closes the same way.
  const managed = spawnManagedProviderProcess(
    { command: invocation.command, args: invocation.args, cwd: invocation.cwd },
    {
      site: CODEX_APP_SERVER_KILL_SITE,
      inheritedEnv: pairedEnv,
      spawnImpl: (spec) =>
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the managed spec's first three stdio slots are 'pipe', so stdin, stdout and stderr exist.
        spawnImpl(spec.program, [...(spec.args ?? [])], {
          env: spec.env,
          cwd: spec.cwd,
          stdio: spec.stdio ?? ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          ...(spec.detached ? { detached: true } : {})
        }) as ChildProcessWithoutNullStreams
    }
  )
  const { child } = managed

  let exited = false
  let timedOut = false
  let nextRequestId = 1
  const pending = new Map<
    number,
    { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void }
  >()

  managed.onExit(() => {
    exited = true
  })
  // Why: 'error' fires instead of 'exit' when the spawn itself fails
  // (ENOENT); surface it to every in-flight request or they wait forever.
  let spawnError: Error | null = null
  child.on('error', (error) => {
    spawnError = error
    exited = true
    failPending(error)
  })
  // Why: 'close' (not 'exit') guarantees the stderr tail is complete, so an
  // early death classifies correctly as missing-subcommand vs transient.
  managed.onSettled(() => {
    failPending(buildEarlyExitError())
  })
  // Why: a child can exit between the liveness check and stdin.write(); an
  // EPIPE must reject the RPC instead of becoming an unhandled stream error.
  child.stdin.on('error', (error) => {
    failPending(error)
  })

  createProviderRecordReader({
    stdout: child.stdout,
    onRecord: (parsed) => {
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return
      }
      const message = parsed as JsonRpcResponse
      if (typeof message.id !== 'number') {
        return
      }
      const waiter = pending.get(message.id)
      if (waiter) {
        pending.delete(message.id)
        waiter.resolve(message)
      }
    },
    onRejected: () => undefined,
    onFatal: failPending
  })

  function failPending(error: Error): void {
    for (const waiter of pending.values()) {
      waiter.reject(error)
    }
    pending.clear()
  }

  let rejectDeadline: (error: Error) => void = () => {}
  const deadlinePromise = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject
  })
  function endSession(error: Error): void {
    timedOut = true
    // The owner close in finally runs as soon as this rejection wins the session race.
    if (!managed.dedicatedGroup) {
      killCodexAppServerProcessTree(child)
    }
    failPending(error)
    rejectDeadline(error)
  }
  const deadline = setTimeout(
    () =>
      endSession(
        new CodexAppServerTimeoutError(
          `codex app-server session exceeded ${invocation.timeoutMs}ms (${invocation.command})`
        )
      ),
    invocation.timeoutMs
  )
  const onAbort = (): void => endSession(new Error('codex app-server session stopped'))
  if (invocation.signal?.aborted) {
    onAbort()
  } else {
    invocation.signal?.addEventListener('abort', onAbort, { once: true })
  }

  function sendLine(payload: Record<string, unknown>): void {
    child.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  function notify(method: string, params?: Record<string, unknown>): void {
    const payload: Record<string, unknown> = { method }
    if (params !== undefined) {
      payload.params = params
    }
    try {
      sendLine(payload)
    } catch {
      // Notifications are fire-and-forget; a dead child fails the next request.
    }
  }

  async function requestRpc(
    method: string,
    params?: Record<string, unknown>,
    options: { timeoutMs?: number | null } = {}
  ): Promise<unknown> {
    if (spawnError) {
      throw spawnError
    }
    if (timedOut) {
      throw new CodexAppServerTimeoutError('codex app-server session already timed out')
    }
    if (exited) {
      throw buildEarlyExitError()
    }
    const id = nextRequestId++
    let requestTimer: ReturnType<typeof setTimeout> | undefined
    const response = await new Promise<JsonRpcResponse>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      const { timeoutMs } = options
      if (typeof timeoutMs === 'number') {
        requestTimer = setTimeout(() => {
          pending.delete(id)
          reject(
            new CodexAppServerTimeoutError(`codex app-server ${method} exceeded ${timeoutMs}ms`)
          )
        }, timeoutMs)
      }
      const payload: Record<string, unknown> = { method, id }
      if (params !== undefined) {
        payload.params = params
      }
      try {
        sendLine(payload)
      } catch (error) {
        pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    }).finally(() => clearTimeout(requestTimer))
    if (response.error) {
      if (isCodexMethodNotFoundError(response.error)) {
        throw new CodexAppServerUnsupportedError(
          `codex app-server does not support ${method}: ${response.error.message ?? 'method not found'}`
        )
      }
      throw new Error(
        `codex app-server ${method} failed: ${response.error.message ?? 'unknown error'}`
      )
    }
    return response.result
  }

  function stderrDetail(): string {
    return managed.stderrTail().trim().slice(0, STDERR_DETAIL_MAX_CHARS)
  }

  function buildEarlyExitError(): Error {
    if (stderrIndicatesMissingAppServer(managed.stderrTail())) {
      return new CodexAppServerUnsupportedError(
        `codex CLI does not support the app-server subcommand: ${stderrDetail()}`
      )
    }
    return new Error(
      `codex app-server exited before completing the session${managed.stderrTail() ? `: ${stderrDetail()}` : ''}`
    )
  }

  try {
    const session = async (): Promise<T> => {
      await requestRpc('initialize', {
        clientInfo: { name: 'orca_desktop', title: 'Orca', version: '0.0.0' }
      })
      notify('initialized')
      return body({ request: requestRpc, notify })
    }
    // Why: the timeout owns the whole callback, including time between RPCs;
    // killing the child alone cannot settle a callback awaiting unrelated work.
    return await Promise.race([session(), deadlinePromise])
  } catch (error) {
    if (
      error instanceof Error &&
      !(error instanceof CodexAppServerUnsupportedError) &&
      !(error instanceof CodexAppServerTimeoutError) &&
      stderrIndicatesMissingAppServer(managed.stderrTail())
    ) {
      throw new CodexAppServerUnsupportedError(
        `codex CLI does not support the app-server subcommand: ${stderrDetail()}`
      )
    }
    throw error
  } finally {
    if (invocation.treeKillOnFinish && !managed.dedicatedGroup && !exited) {
      await managed.terminateTree()
    }
    // The shared owner finishes group cleanup before this caller releases its resources.
    await managed.close()
    clearTimeout(deadline)
    invocation.signal?.removeEventListener('abort', onAbort)
  }
}
