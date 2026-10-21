import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState
} from '../../../shared/managed-account-types'
import {
  HOST_ACCOUNT_SIGN_IN_SETTLED_PHASES,
  type HostAccountSignInProvider,
  type HostAccountSignInStatus
} from '../../../shared/host-account-sign-in-types'
import { HOST_ACCOUNT_SIGN_IN_RUNTIME_CAPABILITY } from '../../../shared/account-runtime-capabilities'
import { CODEX_LOGIN_CANCELLED_MESSAGE } from '../../../shared/codex-auth-errors'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { assertRuntimeEnvironmentCapability, callRuntimeRpc } from './runtime-rpc-client'
import { captureRuntimeEnvironmentRequestRevision } from './runtime-environment-revision'
import { classifyTerminalProcessInspectionFailure } from '../../../shared/terminal-process-inspection'

type EnvironmentTarget = Extract<RuntimeClientTarget, { kind: 'environment' }>

const CALL_TIMEOUT_MS = 20_000
// Why above the host's 20s long poll: an unchanged flow answers at its own deadline, not ours.
const WAIT_TIMEOUT_MS = 35_000
const WAIT_RETRY_WINDOW_MS = 80_000
const WAIT_RETRY_DELAY_MS = 2_000
const NOT_ACTIVE = 'This sign-in is no longer active in this client.'
const CANCELLED_MESSAGE: Record<HostAccountSignInProvider, string> = {
  claude: 'Claude sign-in was cancelled.',
  codex: CODEX_LOGIN_CANCELLED_MESSAGE
}

/**
 * One Add Account click against one server, registered before its first await so a Cancel at any
 * point lands on it. Pinned to the pairing it started on: a re-paired id names another machine,
 * which must never get this flow's code.
 */
type Attempt = {
  owner: EnvironmentTarget
  provider: HostAccountSignInProvider
  pairingRevision: number | undefined
  cancelled: boolean
  /** The host's flow, once it answered the start. */
  status: HostAccountSignInStatus | null
}

/** The attempt each server runs for this client, per provider. */
const attempts = new Map<string, Attempt>()
const listeners = new Set<() => void>()

const keyOf = (owner: EnvironmentTarget, provider: HostAccountSignInProvider): string =>
  `${owner.environmentId}\u0000${provider}`

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

function call(
  attempt: Attempt,
  method: string,
  params: unknown,
  timeoutMs = CALL_TIMEOUT_MS
): Promise<HostAccountSignInStatus> {
  return callRuntimeRpc<HostAccountSignInStatus>(attempt.owner, method, params, {
    timeoutMs,
    expectedEnvironmentPairingRevision: attempt.pairingRevision
  })
}

/** Records a newer status of the attempt's own flow; a slow answer never rolls it back. */
function advance(attempt: Attempt, status: HostAccountSignInStatus): void {
  const current = attempt.status
  if (current && (status.flowId !== current.flowId || status.revision <= current.revision)) {
    return
  }
  attempt.status = status
  if (attempts.get(keyOf(attempt.owner, attempt.provider)) === attempt) {
    notify()
  }
}

export function subscribeHostAccountSignIns(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function readHostAccountSignIn(
  owner: RuntimeClientTarget,
  provider: HostAccountSignInProvider
): HostAccountSignInStatus | null {
  return owner.kind === 'environment'
    ? (attempts.get(keyOf(owner, provider))?.status ?? null)
    : null
}

/** Only a lost answer is worth asking again; a refusal or a re-paired server is final. */
function isRetryable(error: unknown): boolean {
  const reason = classifyTerminalProcessInspectionFailure(error)
  return reason === 'timeout' || reason === 'transport_loss'
}

async function waitForChange(
  attempt: Attempt,
  status: HostAccountSignInStatus
): Promise<HostAccountSignInStatus> {
  // Why a window: the host ends a flow nobody asked about for 90s, so asking longer is pointless.
  const giveUpAt = Date.now() + WAIT_RETRY_WINDOW_MS
  for (;;) {
    try {
      return await call(
        attempt,
        'accounts.hostSignInWait',
        { flowId: status.flowId, afterRevision: status.revision },
        WAIT_TIMEOUT_MS
      )
    } catch (error) {
      if (!isRetryable(error) || Date.now() >= giveUpAt) {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, WAIT_RETRY_DELAY_MS))
    }
  }
}

async function runHostAccountSignIn(
  owner: EnvironmentTarget,
  provider: HostAccountSignInProvider
): Promise<HostAccountSignInStatus> {
  const key = keyOf(owner, provider)
  const attempt: Attempt = {
    owner,
    provider,
    pairingRevision: captureRuntimeEnvironmentRequestRevision(owner.environmentId),
    cancelled: false,
    status: null
  }
  attempts.set(key, attempt)
  try {
    await assertRuntimeEnvironmentCapability(
      owner.environmentId,
      HOST_ACCOUNT_SIGN_IN_RUNTIME_CAPABILITY,
      'This server runs an older Orca that cannot add accounts from here. Update Orca on that server, or run `orca account add` in a terminal there.'
    )
    if (attempt.cancelled) {
      throw new Error(CANCELLED_MESSAGE[provider])
    }
    advance(attempt, await call(attempt, 'accounts.hostSignInStart', { provider }))
    if (attempt.cancelled) {
      // Why: the Cancel came before the host named its flow; tell it now.
      await requestHostCancel(attempt)
    }
    let status = attempt.status
    while (status && !HOST_ACCOUNT_SIGN_IN_SETTLED_PHASES.has(status.phase)) {
      advance(attempt, await waitForChange(attempt, status))
      status = attempt.status
    }
    if (status?.phase === 'signedIn') {
      return status
    }
    throw new Error(
      status?.phase === 'cancelled' || !status
        ? CANCELLED_MESSAGE[provider]
        : (status.error ?? 'Sign-in failed. Try again.')
    )
  } finally {
    if (attempts.get(key) === attempt) {
      attempts.delete(key)
      notify()
    }
  }
}

async function requestHostCancel(attempt: Attempt): Promise<void> {
  if (attempt.status) {
    advance(
      attempt,
      await call(attempt, 'accounts.hostSignInCancel', { flowId: attempt.status.flowId })
    )
  }
}

/** Adds a Claude account on `owner`: its login runs there, and this client relays the code. */
export async function addClaudeAccountOnHost(
  owner: EnvironmentTarget
): Promise<ClaudeRateLimitAccountsState> {
  const status = await runHostAccountSignIn(owner, 'claude')
  if (!status.claude) {
    throw new Error('Claude signed in, but the server sent no account list.')
  }
  return status.claude
}

/** Adds a Codex account on `owner` through codex's device code, opened on this device. */
export async function addCodexAccountOnHost(
  owner: EnvironmentTarget
): Promise<CodexRateLimitAccountsState> {
  const status = await runHostAccountSignIn(owner, 'codex')
  if (!status.codex) {
    throw new Error('Codex signed in, but the server sent no account list.')
  }
  return status.codex
}

export async function submitHostAccountSignInCode(
  owner: RuntimeClientTarget,
  provider: HostAccountSignInProvider,
  code: string
): Promise<void> {
  const attempt = owner.kind === 'environment' ? attempts.get(keyOf(owner, provider)) : undefined
  if (!attempt?.status) {
    throw new Error(NOT_ACTIVE)
  }
  advance(
    attempt,
    await call(attempt, 'accounts.hostSignInSubmitCode', { flowId: attempt.status.flowId, code })
  )
}

/** True when there was a sign-in to cancel. */
export async function cancelHostAccountSignIn(
  owner: RuntimeClientTarget,
  provider: HostAccountSignInProvider
): Promise<boolean> {
  const attempt = owner.kind === 'environment' ? attempts.get(keyOf(owner, provider)) : undefined
  if (!attempt) {
    return false
  }
  attempt.cancelled = true
  await requestHostCancel(attempt)
  return true
}
