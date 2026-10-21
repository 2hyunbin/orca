import { app } from 'electron'
import { AGENT_SESSION_WORKSPACE_SLEEP_MARK_RUNTIME_CAPABILITY } from '../../../shared/agent-session-workspace-sleep'
import { lastVerifiedRuntimeStatus } from '../../../shared/runtime-host-status'
import type { RemoteWorkspaceCall } from '../../runtime/workspaces/remote-workspace-terminal-sleep'
import type { WorkspaceSleepEnvironments } from '../../runtime/workspaces/workspace-sleep-environment-slot'
import { callRuntimeEnvironment } from './runtime-environment-transport-routing'
import { getRuntimeEnvironmentStatusSnapshots } from './runtime-environment-request-connections'

function callEnvironment(environmentId: string): RemoteWorkspaceCall {
  return async (method, params, timeoutMs) => {
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
  const snapshot = getRuntimeEnvironmentStatusSnapshots().find(
    (entry) => entry.environmentId === environmentId
  )
  return (
    lastVerifiedRuntimeStatus({ snapshot })?.capabilities?.includes(
      AGENT_SESSION_WORKSPACE_SLEEP_MARK_RUNTIME_CAPABILITY
    ) === true
  )
}

/** How a desktop's workspace sleep reaches the paired servers that own its terminals or chats. */
export const runtimeEnvironmentWorkspaceSleep: WorkspaceSleepEnvironments = {
  callEnvironment,
  environmentMarksSleep
}
