import { AGENT_SESSION_WORKSPACE_SLEEP_MARK_RUNTIME_CAPABILITY } from '../../../shared/agent-session-workspace-sleep'
import type { RuntimeWorktreeTerminalSleepResult } from '../../../shared/runtime-types'
import type { WorkspaceSleepNotice } from '../../../shared/workspace-sleep'
import { lastVerifiedRuntimeStatus } from '../../../shared/runtime-host-status'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import { getWorkspaceVmSuspend } from '../../ephemeral-vm-workspace-suspend-slot'
import type { RemoteWorkspaceCall } from './remote-workspace-terminal-sleep'
import type { WorkspaceSleepDeps } from './workspace-sleep-execution'

type SleepRuntime = {
  sleepTerminalsForWorktree: (selector: string) => Promise<RuntimeWorktreeTerminalSleepResult>
  ensureStructuredAgentSessionHost: () => Promise<void>
  notifyWorkspaceSleep: (notice: WorkspaceSleepNotice) => void
}

// Loaded on use: the paired-server transport pulls in all of SSH, which no local sleep needs.
const transport = () =>
  Promise.all([
    import('electron'),
    import('../../ipc/runtime-environments/runtime-environment-transport-routing'),
    import('../../ipc/runtime-environments/runtime-environment-request-connections')
  ])

function callEnvironment(environmentId: string): RemoteWorkspaceCall {
  return async (method, params, timeoutMs) => {
    const [{ app }, { callRuntimeEnvironment }] = await transport()
    const response = await callRuntimeEnvironment(
      app.getPath('userData'),
      environmentId,
      method,
      params,
      timeoutMs
    )
    if (response.ok) {
      return response.result
    }
    // The code survives, so an older server's method_not_found takes the legacy sleep.
    throw Object.assign(new Error(response.error.message), { code: response.error.code })
  }
}

// From the last verified status; a server not yet probed marks nothing and its chats stay awake.
async function environmentMarksSleep(environmentId: string): Promise<boolean> {
  const [, , { getRuntimeEnvironmentStatusSnapshots }] = await transport()
  const snapshot = getRuntimeEnvironmentStatusSnapshots().find(
    (entry) => entry.environmentId === environmentId
  )
  return (
    lastVerifiedRuntimeStatus({ snapshot })?.capabilities?.includes(
      AGENT_SESSION_WORKSPACE_SLEEP_MARK_RUNTIME_CAPABILITY
    ) === true
  )
}

/** This host's way to run each part of a workspace's sleep. */
export function workspaceSleepDeps(runtime: SleepRuntime): WorkspaceSleepDeps {
  return {
    notify: (notice) => runtime.notifyWorkspaceSleep(notice),
    sleepOwnTerminals: (worktreeId) => runtime.sleepTerminalsForWorktree(`id:${worktreeId}`),
    callEnvironment,
    stopOwnChats: async (worktreeId, markAsleep) => {
      await runtime.ensureStructuredAgentSessionHost()
      const host = getStructuredAgentSessionHost()
      if (!host) {
        throw new Error('structured_agent_session_host_unavailable')
      }
      return host.sleepWorkspace(worktreeId, markAsleep)
    },
    environmentMarksSleep,
    suspendVm: getWorkspaceVmSuspend()
  }
}
