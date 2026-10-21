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

type EnvironmentTarget = Extract<RuntimeClientTarget, { kind: 'environment' }>

const CALL_TIMEOUT_MS = 20_000
// Why above the host's 20s long poll: an unchanged flow answers at its own deadline, not ours.
const WAIT_TIMEOUT_MS = 35_000
const WAIT_RETRIES = 3
const WAIT_RETRY_DELAY_MS = 2_000
const CANCELLED_MESSAGE: Record<HostAccountSignInProvider, string> = {
  claude: 'Claude sign-in was cancelled.',
  codex: CODEX_LOGIN_CANCELLED_MESSAGE
}

/** The sign-in each server runs for this client, per provider, while it is shown. */
const shown = new Map<string, { owner: EnvironmentTarget; status: HostAccountSignInStatus }>()
const listeners = new Set<() => void>()

const keyOf = (owner: EnvironmentTarget, provider: HostAccountSignInProvider): string =>
  `${owner.environmentId}\u0000${provider}`

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

function publish(owner: EnvironmentTarget, status: HostAccountSignInStatus): void {
  const key = keyOf(owner, status.provider)
  const current = shown.get(key)?.status
  // Why: a slow answer must not roll a newer status back.
  if (current?.flowId === status.flowId && current.revision > status.revision) {
    return
  }
  shown.set(key, { owner, status })
  notify()
}

function clear(
  owner: EnvironmentTarget,
  provider: HostAccountSignInProvider,
  flowId: string
): void {
  const key = keyOf(owner, provider)
  if (shown.get(key)?.status.flowId === flowId) {
    shown.delete(key)
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
  return owner.kind === 'environment' ? (shown.get(keyOf(owner, provider))?.status ?? null) : null
}

async function waitForChange(
  owner: EnvironmentTarget,
  status: HostAccountSignInStatus
): Promise<HostAccountSignInStatus> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await callRuntimeRpc<HostAccountSignInStatus>(
        owner,
        'accounts.hostSignInWait',
        { flowId: status.flowId, afterRevision: status.revision },
        { timeoutMs: WAIT_TIMEOUT_MS }
      )
    } catch (error) {
      // Why retry: a dropped answer says nothing about the login, which keeps running on the host.
      if (attempt >= WAIT_RETRIES) {
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
  await assertRuntimeEnvironmentCapability(
    owner.environmentId,
    HOST_ACCOUNT_SIGN_IN_RUNTIME_CAPABILITY,
    'This server runs an older Orca that cannot add accounts from here. Update Orca on that server, or run `orca account add` in a terminal there.'
  )
  let status = await callRuntimeRpc<HostAccountSignInStatus>(
    owner,
    'accounts.hostSignInStart',
    { provider },
    { timeoutMs: CALL_TIMEOUT_MS }
  )
  const { flowId } = status
  publish(owner, status)
  try {
    while (!HOST_ACCOUNT_SIGN_IN_SETTLED_PHASES.has(status.phase)) {
      status = await waitForChange(owner, status)
      publish(owner, status)
    }
  } finally {
    clear(owner, provider, flowId)
  }
  if (status.phase === 'signedIn') {
    return status
  }
  throw new Error(
    status.phase === 'cancelled'
      ? CANCELLED_MESSAGE[provider]
      : (status.error ?? 'Sign-in failed. Try again.')
  )
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
  const current = owner.kind === 'environment' ? shown.get(keyOf(owner, provider)) : undefined
  if (!current) {
    throw new Error('This sign-in is no longer active in this client.')
  }
  const status = await callRuntimeRpc<HostAccountSignInStatus>(
    current.owner,
    'accounts.hostSignInSubmitCode',
    { flowId: current.status.flowId, code },
    { timeoutMs: CALL_TIMEOUT_MS }
  )
  publish(current.owner, status)
}

/** True when there was a sign-in to cancel. */
export async function cancelHostAccountSignIn(
  owner: RuntimeClientTarget,
  provider: HostAccountSignInProvider
): Promise<boolean> {
  const current = owner.kind === 'environment' ? shown.get(keyOf(owner, provider)) : undefined
  if (!current) {
    return false
  }
  const status = await callRuntimeRpc<HostAccountSignInStatus>(
    current.owner,
    'accounts.hostSignInCancel',
    { flowId: current.status.flowId },
    { timeoutMs: CALL_TIMEOUT_MS }
  )
  publish(current.owner, status)
  return true
}
