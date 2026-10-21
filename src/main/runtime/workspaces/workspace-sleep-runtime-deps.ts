import type { RuntimeWorktreeTerminalSleepResult } from '../../../shared/runtime-types'
import type { WorkspaceSleepNotice } from '../../../shared/workspace-sleep'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import { getWorkspaceVmSuspend } from '../../ephemeral-vm-workspace-suspend-slot'
import type { RemoteWorkspaceCall } from './remote-workspace-terminal-sleep'
import type { WorkspaceSleepDeps } from './workspace-sleep-execution'
import { getWorkspaceSleepEnvironments } from './workspace-sleep-environment-slot'

type SleepRuntime = {
  sleepTerminalsForWorktree: (selector: string) => Promise<RuntimeWorktreeTerminalSleepResult>
  ensureStructuredAgentSessionHost: () => Promise<void>
  notifyWorkspaceSleep: (notice: WorkspaceSleepNotice) => void
}

// A host without paired servers refuses with a code: a refusal, not a lost server.
function noEnvironments(): RemoteWorkspaceCall {
  return async () => {
    throw Object.assign(new Error('This host has no paired servers.'), {
      code: 'runtime_environment_unavailable'
    })
  }
}

/** This host's way to run each part of a workspace's sleep. */
export function workspaceSleepDeps(runtime: SleepRuntime): WorkspaceSleepDeps {
  return {
    notify: (notice) => runtime.notifyWorkspaceSleep(notice),
    sleepOwnTerminals: (worktreeId) => runtime.sleepTerminalsForWorktree(`id:${worktreeId}`),
    callEnvironment: (environmentId) =>
      (getWorkspaceSleepEnvironments()?.callEnvironment ?? noEnvironments)(environmentId),
    stopOwnChats: async (worktreeId, markAsleep) => {
      await runtime.ensureStructuredAgentSessionHost()
      const host = getStructuredAgentSessionHost()
      if (!host) {
        throw new Error('structured_agent_session_host_unavailable')
      }
      return host.sleepWorkspace(worktreeId, markAsleep)
    },
    environmentMarksSleep: async (environmentId) =>
      (await getWorkspaceSleepEnvironments()?.environmentMarksSleep(environmentId)) === true,
    suspendVm: getWorkspaceVmSuspend()
  }
}
