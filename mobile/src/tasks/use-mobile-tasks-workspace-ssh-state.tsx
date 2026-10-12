import type { WorkspaceSparseActionsModel } from './use-mobile-tasks-workspace-sparse-actions'
import { taskRepoClient, taskRepoServer } from './task-repo-host-routing'
import { workspaceSshTargetKey } from './workspace-ssh-gate'
import type { WorkspaceSshRecord } from './workspace-ssh-gate'
import {
  normalizeSetupHookTrust,
  pickWorkspaceAgent,
  resolveWorkspaceAgentSelection,
  useCallback,
  useEffect,
  useMemo
} from './mobile-tasks-dependencies'
import type {
  RepoHooksResponse,
  RepoSummary,
  SetupDecision
} from './mobile-tasks-legacy-foundation'
import {
  localAgentDetectionRead,
  remoteAgentDetectionRead,
  repoSetupHooksRead,
  sshRepoConnectRun,
  sshRepoStateRead
} from './mobile-workspace-source-operations'

export function useMobileTasksWorkspaceSshState(model: WorkspaceSparseActionsModel) {
  const {
    client,
    runtimeTaskSettings,
    setWorkspaceAgent,
    setWorkspaceAgentOverridden,
    setWorkspaceDetectedAgentIds,
    setWorkspaceSshConnecting,
    setWorkspaceSshState,
    tasksSupported,
    workspaceAgent,
    workspaceAgentOverridden,
    workspaceCreateDraft,
    workspaceCreateRequiresSshConnection,
    workspaceCreateSshStatus,
    workspaceCreateTargetConnectionId,
    workspaceCreateTargetRepo,
    workspaceCreateTargetSshKey,
    workspaceDetectedAgentIds,
    workspaceSshState
  } = model
  const connectWorkspaceSshRepo = useCallback(async (): Promise<void> => {
    if (
      !client ||
      !tasksSupported ||
      !workspaceCreateTargetRepo ||
      !workspaceCreateTargetConnectionId
    ) {
      return
    }
    const target = workspaceCreateTargetSshKey
    const record = (status: WorkspaceSshRecord['status'], error: string | null) => ({
      targetId: workspaceCreateTargetConnectionId,
      status,
      error,
      reconnectAttempt: 0
    })
    // A reply lands only while its target is still the one shown, so it never overwrites another's.
    const settle = (settled: WorkspaceSshRecord) =>
      setWorkspaceSshState((current) =>
        current?.target === target ? { target, record: settled } : current
      )
    setWorkspaceSshConnecting(true)
    setWorkspaceSshState({ target, record: record('connecting', null) })
    try {
      const reply = await sshRepoConnectRun.request(
        taskRepoClient(client, workspaceCreateTargetRepo),
        { targetId: workspaceCreateTargetConnectionId },
        { timeoutMs: 120_000 }
      )
      settle(sshRepoConnectRun.interpret(reply) ?? record('connected', null))
    } catch (err) {
      settle(
        record('error', err instanceof Error ? err.message : 'Failed to connect to SSH repository.')
      )
    } finally {
      setWorkspaceSshConnecting(false)
    }
  }, [client, tasksSupported, workspaceCreateTargetRepo, workspaceCreateTargetSshKey])

  const ensureWorkspaceSshReady = useCallback(
    async (repo: RepoSummary): Promise<void> => {
      if (!repo.connectionId || !client || !tasksSupported) {
        return
      }
      const target = workspaceSshTargetKey(taskRepoServer(repo), repo.connectionId)
      if (workspaceSshState?.target === target && workspaceSshState.record.status === 'connected') {
        return
      }
      const reply = await sshRepoStateRead.request(taskRepoClient(client, repo), {
        targetId: repo.connectionId
      })
      const state = sshRepoStateRead.interpret(reply) ?? null
      if (state) {
        setWorkspaceSshState({ target, record: state })
      }
      if (state?.status !== 'connected') {
        throw new Error(`Connect ${repo.displayName} before creating a workspace.`)
      }
    },
    [client, tasksSupported, workspaceSshState]
  )

  useEffect(() => {
    if (!tasksSupported || !workspaceCreateDraft || !client || !workspaceCreateTargetRepo) {
      setWorkspaceDetectedAgentIds(null)
      return
    }
    if (workspaceCreateTargetRepo.connectionId && workspaceCreateSshStatus !== 'connected') {
      // Why: remote agent detection runs on the SSH host through the relay; a
      // disconnected repo would fail and cache an empty agent list.
      setWorkspaceDetectedAgentIds(null)
      return
    }
    let stale = false
    setWorkspaceDetectedAgentIds(null)
    const repoClient = taskRepoClient(client, workspaceCreateTargetRepo)
    const detection = workspaceCreateTargetRepo.connectionId
      ? {
          operation: remoteAgentDetectionRead,
          reply: remoteAgentDetectionRead.request(repoClient, {
            connectionId: workspaceCreateTargetRepo.connectionId
          })
        }
      : { operation: localAgentDetectionRead, reply: localAgentDetectionRead.request(repoClient) }
    void detection.reply
      .then((reply) => {
        if (stale) {
          return
        }
        const detected = detection.operation.interpret(reply)
        setWorkspaceDetectedAgentIds(detected.accepted ? new Set(detected.value) : new Set())
      })
      .catch(() => {
        if (!stale) {
          setWorkspaceDetectedAgentIds(new Set())
        }
      })
    return () => {
      stale = true
    }
  }, [
    client,
    tasksSupported,
    workspaceCreateDraft,
    workspaceCreateSshStatus,
    workspaceCreateTargetRepo
  ])

  const workspaceAgentSelection = resolveWorkspaceAgentSelection({
    selectionActive: tasksSupported && workspaceCreateDraft !== null,
    settings: runtimeTaskSettings,
    detectedAgentIds: workspaceDetectedAgentIds,
    agent: workspaceAgent,
    overridden: workspaceAgentOverridden
  })
  if (
    workspaceAgentSelection.agent !== workspaceAgent ||
    workspaceAgentSelection.overridden !== workspaceAgentOverridden
  ) {
    // Why: the drawer can open before SSH/local detection settles. Resolve the
    // visible agent before commit so users do not see an unavailable override.
    // react-doctor-disable-next-line react-doctor/no-prop-callback-in-render
    setWorkspaceAgent(workspaceAgentSelection.agent)
    // react-doctor-disable-next-line react-doctor/no-prop-callback-in-render
    setWorkspaceAgentOverridden(workspaceAgentSelection.overridden)
  }

  const resolvedWorkspaceAgent = useMemo(
    () => workspaceAgent ?? pickWorkspaceAgent(runtimeTaskSettings, workspaceDetectedAgentIds),
    [runtimeTaskSettings, workspaceAgent, workspaceDetectedAgentIds]
  )
  const workspaceAgentDetectionPending =
    workspaceCreateDraft != null &&
    workspaceCreateTargetRepo != null &&
    !workspaceCreateRequiresSshConnection &&
    workspaceDetectedAgentIds === null

  const resolveCreateSetupDecision = useCallback(
    async (
      repo: RepoSummary,
      override?: Exclude<SetupDecision, 'inherit'>
    ): Promise<
      | { kind: 'decision'; decision: SetupDecision; setupTrust?: RepoHooksResponse['setupTrust'] }
      | {
          kind: 'prompt'
          command: string
          source: string | null | undefined
          setupTrust?: RepoHooksResponse['setupTrust']
        }
    > => {
      if (!client || !tasksSupported) {
        return { kind: 'decision', decision: override ?? 'inherit' }
      }
      const reply = await repoSetupHooksRead.request(client, { repo: `id:${repo.id}` })
      const result = repoSetupHooksRead.interpret(reply)
      const setupCommand = result.hooks?.scripts?.setup?.trim()
      const setupTrust = normalizeSetupHookTrust(result.setupTrust) ?? undefined
      if (!setupCommand) {
        return { kind: 'decision', decision: 'inherit' }
      }
      if (override) {
        return { kind: 'decision', decision: override, setupTrust }
      }
      const setupRunPolicy = result.setupRunPolicy ?? 'run-by-default'
      if (setupRunPolicy === 'ask') {
        return { kind: 'prompt', command: setupCommand, source: result.source, setupTrust }
      }
      return {
        kind: 'decision',
        decision: setupRunPolicy === 'run-by-default' ? 'run' : 'skip',
        setupTrust
      }
    },
    [client, tasksSupported]
  )
  return Object.assign(model, {
    connectWorkspaceSshRepo,
    ensureWorkspaceSshReady,
    workspaceAgentSelection,
    resolvedWorkspaceAgent,
    workspaceAgentDetectionPending,
    resolveCreateSetupDecision
  })
}

export type WorkspaceSshStateModel = ReturnType<typeof useMobileTasksWorkspaceSshState>
