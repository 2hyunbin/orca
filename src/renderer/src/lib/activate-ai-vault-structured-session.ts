import { structuredSessionOpenFeedback } from './structured-session-open-feedback'
export { structuredSessionOpenFeedback } from './structured-session-open-feedback'
import type { AiVaultSession } from '../../../shared/ai-vault-types'
import { activateAndRevealWorktree } from './worktree-activation'
import { activateStructuredAgentSessionById } from './structured-agent-session-tab-activation'
import { useAppStore } from '@/store'
import { getRuntimeEnvironmentIdForWorktree } from './worktree-runtime-owner'
import {
  callRuntimeRpc,
  getRuntimeEnvironmentCapabilityStatus,
  type RuntimeClientTarget
} from '@/runtime/runtime-rpc-client'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/runtime-client-target'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { refreshLocalStructuredSessionWorktreeTabs } from '@/runtime/local-structured-session-tabs-sync'
import { STRUCTURED_AGENT_SESSION_REVEAL_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { SESSION_TABS_CLOSE_AGENT_SESSION_BY_ID_RUNTIME_CAPABILITY } from '../../../shared/session-tabs-close-capabilities'
import { supportsSessionTabsCloseAgentSessionById } from '@/runtime/structured-agent-session-client'
import { isRuntimeCompatBlockError } from '@/runtime/runtime-protocol-compat'
import {
  executionHostIdForStructuredTarget,
  structuredAgentSessionFocusOwner
} from '@/runtime/structured-agent-session-owner'
import {
  captureWebSessionCloseIntent,
  reopenWebSessionCloseIntent
} from '@/runtime/web-session-close-intent'
import { captureWebSessionIntentOwner } from '@/runtime/web-runtime-session-environment'
import { rereadHostSessionTabs } from '@/runtime/host-session-tab-close'
import {
  captureHostIdentityFence,
  isHostIdentityFenceCurrent,
  type HostIdentityFence
} from '@/store/host-catalog-fencing'
import { resolveContinuedRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import { pendingStructuredAgentSessionTabRetirement } from '@/runtime/structured-agent-session-tab-retirement'

const STRUCTURED_SESSION_RESTORE_TIMEOUT_MS = 5_000

/** Why four: the three terminal answers a user can act on differ, and folding them together sends
 *  someone to the wrong remedy — wait, give up, or update the host. `unreachable` is the only one
 *  that improves by retrying, and `gone` means the host said it holds no such chat, never that the
 *  host could not answer for a reason of its own. */
export type StructuredSessionRevealOutcome =
  | 'revealed'
  | 'gone'
  | 'host-cannot-open'
  | 'unreachable'

type StructuredSessionActivationDeps = {
  activate: typeof activateStructuredAgentSessionById
  refresh: (worktreeId: string, target?: RuntimeClientTarget) => Promise<void>
  reveal: (target: {
    worktreeId: string
    sessionId: string
    target?: RuntimeClientTarget
  }) => Promise<StructuredSessionRevealOutcome>
  unavailable: () => void
  gone: () => void
  hostCannotOpen: () => void
}

const defaultDeps: StructuredSessionActivationDeps = {
  activate: activateStructuredAgentSessionById,
  refresh: refreshStructuredSessionTabs,
  reveal: revealStructuredSession,
  ...structuredSessionOpenFeedback
}

/**
 * @param session anything carrying the row's structured pointer — an Agent Session History row or
 * the drag payload built from one. Only `structuredSession` is read, and both surfaces must reach
 * the same reveal, or the same row answers a click and a drop differently.
 */
export async function activateAiVaultStructuredSession(
  session: Pick<AiVaultSession, 'structuredSession'>,
  deps: StructuredSessionActivationDeps = defaultDeps,
  target?: RuntimeClientTarget
): Promise<boolean> {
  const structured = session.structuredSession
  if (!structured) {
    return false
  }
  // Why: the click can chain a refresh, a capability probe, a reveal and a second refresh, each
  // with its own timeout, and nothing on the row says it is working. Without this, an impatient
  // second click runs the whole sequence again and lands its own toast.
  const hostKey = executionHostIdForStructuredTarget(
    target ??
      runtimeTargetForOwnerEnvironment(
        getRuntimeEnvironmentIdForWorktree(useAppStore.getState(), structured.workspaceId)
      )
  )
  const key = `${hostKey}\0${structured.workspaceId}\0${structured.sessionId}`
  const inFlight = activationsInFlight.get(key)
  if (inFlight) {
    return inFlight
  }
  const activation = activateStructuredSession(structured, deps, target)
  activationsInFlight.set(key, activation)
  try {
    return await activation
  } finally {
    activationsInFlight.delete(key)
  }
}

const activationsInFlight = new Map<string, Promise<boolean>>()

async function activateStructuredSession(
  structured: NonNullable<AiVaultSession['structuredSession']>,
  deps: StructuredSessionActivationDeps,
  host?: RuntimeClientTarget
): Promise<boolean> {
  const target = {
    worktreeId: structured.workspaceId,
    sessionId: structured.sessionId,
    ...(host ? { target: host } : {})
  }
  if (!deps.activate(target)) {
    // A refresh alone can answer, and costs one call instead of two. It is only ever an
    // optimization, so a refresh that fails must fall through to the reveal rather than end the
    // click: the host republishing the tab is the repair, and it does not need this to have worked.
    const refreshed = await refreshedWithoutThrowing(deps, structured.workspaceId, host)
    if (!refreshed || !deps.activate(target)) {
      // The inventory genuinely does not carry this chat: it was closed, or this process never
      // published it. Ask the host to republish the tab from the record it still holds on disk.
      const revealed = await deps.reveal(target)
      if (revealed !== 'revealed') {
        if (revealed === 'gone') {
          deps.gone()
        } else if (revealed === 'host-cannot-open') {
          deps.hostCannotOpen()
        } else {
          // Unreachable: we never got an answer, so this is the one case waiting can still fix.
          deps.unavailable()
        }
        return true
      }
      await refreshedWithoutThrowing(deps, structured.workspaceId, host)
      if (!deps.activate(target)) {
        deps.unavailable()
        return true
      }
    }
  }
  if (useAppStore.getState().activeWorktreeId !== structured.workspaceId) {
    activateAndRevealWorktree(structured.workspaceId)
  }
  return true
}

/** The inventory refresh is advisory at every call site here, so its failure is a `false`, never a
 *  thrown end to the click. */
async function refreshedWithoutThrowing(
  deps: StructuredSessionActivationDeps,
  worktreeId: string,
  target?: RuntimeClientTarget
): Promise<boolean> {
  try {
    await (target ? deps.refresh(worktreeId, target) : deps.refresh(worktreeId))
    return true
  } catch {
    return false
  }
}

/**
 * Ask the host to republish a persisted chat's tab.
 *
 * Only `revealed` means the tab is on its way. The other three are all terminal for this click, and
 * they are kept apart because the remedy differs: retry, give up, or update the host.
 */
export async function revealStructuredSession(target: {
  worktreeId: string
  sessionId: string
  target?: RuntimeClientTarget
}): Promise<StructuredSessionRevealOutcome> {
  const host =
    target.target ??
    runtimeTargetForOwnerEnvironment(
      getRuntimeEnvironmentIdForWorktree(useAppStore.getState(), target.worktreeId)
    )
  const fence = captureHostIdentityFence({ target: host, at: 'local' })
  const owner = captureWebSessionIntentOwner(structuredAgentSessionFocusOwner(host).environmentId)
  const ticket = captureWebSessionCloseIntent(
    owner,
    target.worktreeId,
    `agent-session:${target.sessionId}`
  )
  const pendingClose = pendingStructuredAgentSessionTabRetirement(
    host,
    target.worktreeId,
    target.sessionId
  )
  const requestRevision = (): number | undefined =>
    host.kind === 'environment'
      ? resolveContinuedRuntimeEnvironmentRevision(host.environmentId, fence.pairingRevision)
      : undefined
  // The host cannot order reveal behind a close still awaiting its client-side capability probe.
  try {
    if (pendingClose) {
      await withStructuredSessionRestoreTimeout(pendingClose)
    }
  } catch {
    return 'unreachable'
  }
  if (!isHostIdentityFenceCurrent(fence)) {
    return 'unreachable'
  }
  let runtimeId: string | undefined
  let closeSupported: boolean | undefined
  // Negotiated against the host that will answer this call, not the local one: a paired host runs
  // its own build, and its method-not-found is indistinguishable from a refusal we should surface.
  // A local host is this build, so it always has the method and needs no round trip to prove it.
  if (host.kind === 'environment') {
    let supported: boolean
    try {
      // Raced, not merely given a timeout argument: on a cache hit this awaits a promise created
      // by an earlier probe that may carry no deadline of its own, and one that never settles
      // would hold this session's in-flight entry for the life of the process.
      const status = await withStructuredSessionRestoreTimeout(
        getRuntimeEnvironmentCapabilityStatus(
          host.environmentId,
          STRUCTURED_AGENT_SESSION_REVEAL_RUNTIME_CAPABILITY,
          STRUCTURED_SESSION_RESTORE_TIMEOUT_MS,
          { expectedEnvironmentPairingRevision: requestRevision() }
        )
      )
      supported =
        status.capabilities?.includes(STRUCTURED_AGENT_SESSION_REVEAL_RUNTIME_CAPABILITY) === true
      runtimeId = status.runtimeId
      closeSupported =
        status.capabilities?.includes(SESSION_TABS_CLOSE_AGENT_SESSION_BY_ID_RUNTIME_CAPABILITY) ===
        true
    } catch (error) {
      // A version block is the host's age, stated outright; anything else means we never got to
      // ask, which is not evidence about the chat or the host. `remote-agent-session-launch`
      // splits the same probe's failures the same way.
      return isRuntimeCompatBlockError(error) ? 'host-cannot-open' : 'unreachable'
    }
    if (!supported) {
      return 'host-cannot-open'
    }
  }
  if (!isHostIdentityFenceCurrent(fence)) {
    return 'unreachable'
  }
  let result: AgentSessionRevealReply | undefined
  try {
    result = await withStructuredSessionRestoreTimeout(
      callRuntimeRpc<AgentSessionRevealReply>(
        host,
        'agentSession.reveal',
        { sessionId: target.sessionId },
        {
          timeoutMs: STRUCTURED_SESSION_RESTORE_TIMEOUT_MS,
          expectedEnvironmentPairingRevision: requestRevision(),
          expectedEnvironmentRuntimeId: runtimeId
        }
      )
    )
  } catch {
    return 'unreachable'
  }
  if (!isHostIdentityFenceCurrent(fence)) {
    return 'unreachable'
  }
  if (result?.ok === true) {
    await showReopenedChat(fence, target.worktreeId, ticket, closeSupported)
    return 'revealed'
  }
  // The host raises two different refusals here and they mean opposite things to a user: it holds
  // no such record, or it holds one it cannot open. Only the first is the chat being gone.
  return result?.refusal?.code === 'agent_session_identity_required' ? 'gone' : 'host-cannot-open'
}

/** Hosts that close a chat by id also hold a reveal until that chat's close has finished. */
function revealWaitsForClose(host: RuntimeClientTarget): Promise<boolean> {
  return withStructuredSessionRestoreTimeout(supportsSessionTabsCloseAgentSessionById(host)).catch(
    () => false
  )
}

type AgentSessionRevealReply = { ok?: boolean; refusal?: { code?: string } }

/** Cleared at the answer, not the click: a frame from before the close could otherwise flash it. */
async function showReopenedChat(
  fence: HostIdentityFence,
  worktreeId: string,
  ticket: ReturnType<typeof captureWebSessionCloseIntent>,
  closeSupported: boolean | undefined
): Promise<void> {
  const host = fence.route.target
  // Why: an older paired host can commit the close after this reveal, which would show then drop it.
  if (
    !ticket ||
    !(closeSupported ?? (await revealWaitsForClose(host))) ||
    !isHostIdentityFenceCurrent(fence)
  ) {
    return
  }
  if (reopenWebSessionCloseIntent(ticket)) {
    // Why: a frame listing the reopened chat may already have been applied with it hidden.
    await withStructuredSessionRestoreTimeout(
      rereadHostSessionTabs(host, worktreeId, fence.pairingRevision, true)
    ).catch(() => undefined)
  }
}

async function refreshStructuredSessionTabs(
  worktreeId: string,
  target?: RuntimeClientTarget
): Promise<void> {
  const state = useAppStore.getState()
  const host =
    target ??
    runtimeTargetForOwnerEnvironment(getRuntimeEnvironmentIdForWorktree(state, worktreeId))
  if (host.kind === 'local') {
    await withStructuredSessionRestoreTimeout(refreshLocalStructuredSessionWorktreeTabs(worktreeId))
    return
  }
  // Paired inventories arrive through their existing host-scoped subscription.
  await withStructuredSessionRestoreTimeout(
    callRuntimeRpc(
      host,
      'session.tabs.list',
      { worktree: toRuntimeWorktreeSelector(worktreeId) },
      { timeoutMs: STRUCTURED_SESSION_RESTORE_TIMEOUT_MS }
    )
  )
}

async function withStructuredSessionRestoreTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('structured_session_restore_timeout')),
          STRUCTURED_SESSION_RESTORE_TIMEOUT_MS
        )
      })
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}
