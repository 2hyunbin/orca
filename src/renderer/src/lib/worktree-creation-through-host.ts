import { useAppStore } from '@/store'
import { completeHostWorktreeCreation } from '@/lib/worktree-creation-host-completion'
import {
  stageStructuredLaunchPrompt,
  prepareLegacyStructuredLaunchPrompts,
  discardStructuredLaunchPrompts,
  takeBackLegacyStructuredLaunchPrompts
} from '@/lib/structured-agent-session-launch-prompt'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { repoOwnerHostId, runtimeTargetForRepoOwner } from '@/lib/repo-runtime-owner'
import { runtimeRpcTargetForAuthorityKey } from '@/runtime/runtime-client-target'
import { adoptFromEndpoint } from '@/store/adopt-from-endpoint'
import { ensureLocalRuntimeCapabilities } from '@/runtime/local-runtime-capabilities'
import { getRuntimeEnvironmentStatus, callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { resolveWorktreeCreateParent } from '@/store/slices/worktrees/create/worktree-create-parent-pick'
import { buildRuntimeWorktreeCreateParams } from '@/store/slices/worktrees/create/worktree-create-payload'
import { pickClientWorktreeCreateSettings } from '@/store/slices/worktrees/create/client-worktree-create-settings'
import { createStructuredAgentSessionId } from '../../../shared/structured-agent-session-create'
import { createStructuredAgentSessionOperationId } from '../../../shared/structured-agent-session-mutation'
import { isAgentLaunchReplayUnsupportedRefusal } from '../../../shared/agent-launch-replay-refusal'
import { formatAgentTypeLabel } from '../../../shared/agent-type-label'
import { translate } from '@/i18n/i18n'
import {
  AGENT_LAUNCH_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_REPLAY_REQUIRED_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_SURFACE_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_DESKTOP_CREATE_RUNTIME_CAPABILITY
} from '../../../shared/agent-launch-runtime-capability'
import type { AgentLaunchResult } from '../../../shared/agent-launch-intent'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'

const DESKTOP_CREATE_CAPABILITIES = [
  AGENT_LAUNCH_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_REPLAY_REQUIRED_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_SURFACE_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_DESKTOP_CREATE_RUNTIME_CAPABILITY
]

/** Returns false only before effects, when the existing renderer route must handle this create. */
export async function createWorktreeThroughHost(
  creationId: string,
  request: WorktreeCreationRequest
): Promise<boolean> {
  if (
    request.agentLaunchRoute !== 'structured-native-chat' ||
    !request.agent ||
    request.ephemeralVmRecipe ||
    request.ephemeralVmRuntimeId ||
    request.ephemeralVmCheckoutMode
  ) {
    return false
  }
  const state = useAppStore.getState()
  const requestedHostId = request.workspaceRunContext?.hostId ?? request.executionHostId
  const target = requestedHostId
    ? runtimeRpcTargetForAuthorityKey(requestedHostId)
    : runtimeTargetForRepoOwner(state, request.repoId)
  const ownerHostId = requestedHostId ?? repoOwnerHostId(state, request.repoId)
  if (!target || !ownerHostId) {
    return false
  }
  if (!request.hostAgentLaunch?.issued) {
    let capabilities: readonly string[] | null
    try {
      capabilities =
        target.kind === 'local'
          ? await ensureLocalRuntimeCapabilities()
          : ((await getRuntimeEnvironmentStatus(target.environmentId)).capabilities ?? [])
    } catch {
      return false
    }
    if (!DESKTOP_CREATE_CAPABILITIES.every((capability) => capabilities?.includes(capability))) {
      return false
    }
  }
  if (!useAppStore.getState().pendingWorktreeCreations[creationId]) {
    return true
  }
  const executionHostId = adoptFromEndpoint(target, {
    kind: 'createdWorktree',
    requestedHostId,
    resolveOwnHostId: () => ownerHostId
  })
  const parent = resolveWorktreeCreateParent(state, request.parentWorktreeId, executionHostId)
  request.hostAgentLaunch ??= {
    operationId: createStructuredAgentSessionOperationId(createBrowserUuid),
    sessionId: createStructuredAgentSessionId(request.agent, createBrowserUuid),
    paneKey: `${createBrowserUuid()}:${createBrowserUuid()}`,
    create: {
      ...buildRuntimeWorktreeCreateParams(
        {
          ...request,
          startup: undefined,
          createdWithAgent: request.agent,
          creationId,
          options: {
            nameWasGenerated: request.nameWasGenerated,
            displayNameKind: request.displayNameKind,
            linkedWorkItem: request.linkedWorkItem,
            linkedTaskSourceContext: request.linkedTaskSourceContext
          }
        },
        {
          name: request.name,
          branchNameOverride: request.branchNameOverride,
          parentWorkspace: parent.parentWorkspace,
          manualOrder: state.sortBy === 'manual' ? Date.now() : undefined
        }
      ),
      ...pickClientWorktreeCreateSettings(state.settings),
      creationId,
      repoHostId: executionHostId
    },
    issued: false
  }
  const reservation = request.hostAgentLaunch
  useAppStore.getState().updatePendingWorktreeCreation(creationId, { request })
  const replayed = reservation.issued
  const text = request.launchDraftPrompt ?? request.quickPrompt
  if (!replayed && request.promptDelivery !== 'draft' && text?.trim()) {
    stageStructuredLaunchPrompt(reservation.sessionId, text)
    prepareLegacyStructuredLaunchPrompts(reservation.sessionId)
  }
  reservation.issued = true
  const unsubscribe = useAppStore.subscribe((current) => {
    if (!current.pendingWorktreeCreations[creationId]) {
      discardStructuredLaunchPrompts(reservation.sessionId)
    }
  })
  let launch: AgentLaunchResult
  try {
    launch = await callRuntimeRpc<AgentLaunchResult>(
      target,
      'agent.launchReplay',
      {
        agent: request.agent,
        operationId: reservation.operationId,
        sessionId: reservation.sessionId,
        paneKey: reservation.paneKey,
        target: { kind: 'create-worktree', create: reservation.create },
        surface: 'chat',
        launchSource: request.quickTelemetry?.launch_source ?? 'new_workspace_composer',
        sessionOptions: Object.fromEntries(
          Object.entries(request.startupPlan?.sessionOptions ?? {}).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string'
          )
        )
      },
      { timeoutMs: 10 * 60_000 }
    )
  } catch (error) {
    if (
      !replayed &&
      error instanceof RuntimeRpcCallError &&
      isAgentLaunchReplayUnsupportedRefusal(error)
    ) {
      discardStructuredLaunchPrompts(reservation.sessionId)
      delete request.hostAgentLaunch
      return false
    }
    takeBackLegacyStructuredLaunchPrompts(reservation.sessionId)
    if (
      error instanceof RuntimeRpcCallError &&
      (error.code === 'agent_session_operation_unknown' ||
        error.code === 'agent_session_operation_expired')
    ) {
      throw new Error(
        translate(
          'auto.lib.worktreeCreationThroughHost.unconfirmedCreate',
          'Could not confirm whether {{agent}} created the workspace. Retry to check the same request.',
          { agent: formatAgentTypeLabel(request.agent) }
        )
      )
    }
    throw error
  } finally {
    unsubscribe()
  }
  await completeHostWorktreeCreation({
    creationId,
    request,
    target,
    executionHostId,
    parent,
    launch
  })
  return true
}
