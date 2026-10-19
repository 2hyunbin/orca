import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import type { ProspectiveWorkspace } from './agent-launch-route-input'
import {
  agentsOfferedForLaunch,
  resolveChatProgramContext,
  subscribeChatProgramFacts,
  readChatProgramFactsVersion
} from './host-chat-program'
import { ensureLocalRuntimeCapabilities } from '@/runtime/local-runtime-capabilities'
import { relearnHostStructuredAgents } from '@/runtime/host-structured-agents'
import {
  acquireHostStructuredAgentAvailability,
  firstHostStructuredAgentAvailability
} from '@/runtime/host-structured-agent-availability'
import { onRuntimeEnvironmentsRetired } from '@/runtime/runtime-environment-revision'
import { STRUCTURED_AGENT_SESSION_AVAILABILITY_RUNTIME_CAPABILITY as AVAILABILITY } from '../../../shared/protocol-version'
import type { TuiAgent } from '../../../shared/tui-agent'
import { isTuiAgent } from '../../../shared/tui-agent-config'
import {
  getDetectionTargetIdentityForWorktree,
  readAgentInventoryForWorktree
} from './agent-detection-target-inventory'

export function useChatProgramFactsVersion(): number {
  return useSyncExternalStore(
    subscribeChatProgramFacts,
    readChatProgramFactsVersion,
    readChatProgramFactsVersion
  )
}

/** The lease owns listeners and stream holds, even while a shared RPC never settles. */
export function holdChatProgramFacts(workspace: ProspectiveWorkspace) {
  let current = ''
  let release = (): void => {}
  let finish = (): void => {}
  let retired = false
  const ready = new Promise<void>((resolve) => {
    finish = resolve
  })
  const reconcile = (): void => {
    const state = useAppStore.getState()
    const context = resolveChatProgramContext(state, workspace)
    if (current === context.revision || retired) {
      return
    }
    current = context.revision
    release()
    release = (): void => {}
    if (!context.target || context.runtimeId === undefined || !context.hostCapabilities) {
      // A resolved host without a chat runtime (SSH) has nothing to acquire, and a failed local
      // probe is an answer: capabilities stay unknown and the launch rechecks.
      if (!context.target && context.executionHostId) {
        finish()
      } else if (context.target && context.runtimeId === null) {
        void ensureLocalRuntimeCapabilities().then((known) => known || finish())
      }
      return
    }
    const catalog = relearnHostStructuredAgents(
      context.executionHostId,
      context.hostCapabilities,
      state.runtimeStatusByEnvironmentId
    )
    let health = Promise.resolve()
    if (context.hostCapabilities.includes(AVAILABILITY)) {
      const owner = { ...context, target: context.target, runtimeId: context.runtimeId }
      release = acquireHostStructuredAgentAvailability(owner)
      health = firstHostStructuredAgentAvailability(owner)
    }
    const revision = current
    void Promise.all([catalog, health]).then(() => !retired && revision === current && finish())
  }
  const stopStore = useAppStore.subscribe(reconcile)
  const stopFacts = subscribeChatProgramFacts(reconcile)
  reconcile()
  return {
    ready,
    release: () => {
      retired = true
      stopStore()
      stopFacts()
      release()
      finish()
    }
  }
}

export function useChatProgramFacts(workspace: ProspectiveWorkspace, active = true): void {
  useChatProgramFactsVersion()
  const key = useAppStore((state) => resolveChatProgramContext(state, workspace).revision)
  useEffect(() => {
    return active ? holdChatProgramFacts(workspace).release : undefined
    // The descriptor covers all owner inputs; resource notifications do not reopen a live lease.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, active])
}

/** Listing and selected-entry readiness are separate; null preserves pending-inventory fallback. */
export function useAgentsOfferedForLaunch(
  workspace: ProspectiveWorkspace,
  detected: ReadonlySet<TuiAgent> | null
): ReadonlySet<TuiAgent> | null {
  useChatProgramFacts(workspace)
  const key = useAppStore((state) =>
    detected === null ? null : agentsOfferedForLaunch(state, workspace, [...detected]).join(',')
  )
  return useMemo(() => (key === null ? null : new Set(key.split(',').filter(isTuiAgent))), [key])
}

export class AgentLaunchChoiceCancelled extends Error {}

/** Chat discovery is bounded; ordinary CLI discovery keeps its existing wait. */
export async function acquireAgentLaunchChoices(
  workspace: ProspectiveWorkspace,
  detect: () => Promise<readonly TuiAgent[] | null>,
  signal?: AbortSignal,
  totalDeadline = false
) {
  let bound = resolveChatProgramContext(useAppStore.getState(), workspace)
  let target = workspace.worktreeId
    ? getDetectionTargetIdentityForWorktree(useAppStore.getState(), workspace.worktreeId)
    : null
  let cancel = (): void => {}
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () =>
      reject(new AgentLaunchChoiceCancelled('Agent launch owner changed or action cancelled'))
  })
  const check = (): void => {
    const next = resolveChatProgramContext(useAppStore.getState(), workspace)
    const nextTarget = workspace.worktreeId
      ? getDetectionTargetIdentityForWorktree(useAppStore.getState(), workspace.worktreeId)
      : null
    if (
      (bound.executionHostId && next.executionHostId !== bound.executionHostId) ||
      (bound.runtimeId !== undefined && next.runtimeId !== bound.runtimeId) ||
      (bound.pairingRevision !== undefined && next.pairingRevision !== bound.pairingRevision) ||
      (target && nextTarget !== target)
    ) {
      cancel()
    } else {
      bound = next
      target = nextTarget
    }
  }
  const stopStore = useAppStore.subscribe(check)
  const stopFacts = subscribeChatProgramFacts(check)
  const stopRetirement = onRuntimeEnvironmentsRetired(
    (ids) => bound.environmentId && ids.includes(bound.environmentId) && cancel()
  )
  const lease = holdChatProgramFacts(workspace)
  let expire = (): void => {}
  const expired = new Promise<null>((resolve) => {
    expire = () => {
      lease.release()
      resolve(null)
    }
  })
  const timer = setTimeout(expire, 5_000)
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    if (signal?.aborted) {
      cancel()
    }
    const detection = detect()
    const detected = await Promise.race([
      totalDeadline ? Promise.race([detection, expired]) : detection,
      cancelled
    ])
    await Promise.race([lease.ready, cancelled])
    check()
    // A settled rejection queues first, so an owner change seen by check() wins.
    await Promise.race([cancelled, Promise.resolve()])
    const inventory = workspace.worktreeId
      ? readAgentInventoryForWorktree(useAppStore.getState(), workspace.worktreeId)
      : null
    const trustworthy = inventory
      ? inventory.state === 'successful' || inventory.ids?.length
        ? inventory.ids
        : null
      : detected
    return {
      detected: trustworthy,
      offered: agentsOfferedForLaunch(useAppStore.getState(), workspace, trustworthy)
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
    stopStore()
    stopFacts()
    stopRetirement()
    lease.release()
  }
}
