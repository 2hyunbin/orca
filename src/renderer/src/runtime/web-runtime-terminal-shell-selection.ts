import { TERMINAL_CREATE_SHELL_SELECTION_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { isRuntimeCompatBlockError } from './runtime-protocol-compat'
import { unwrapRuntimeRpcResult } from './runtime-rpc-result'
import { runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import type { captureRuntimeEnvironmentCall } from './web-runtime-session-environment'
import {
  createdTerminalLeafId,
  readCreatedAgentTerminalIdentity
} from './web-runtime-terminal-identity'

/** Whether the host's terminal.create runs the requested shell itself instead of its default. */
export async function hostCreatesRequestedShell(environmentId: string): Promise<boolean> {
  try {
    return await runtimeEnvironmentSupportsCapability(
      environmentId,
      TERMINAL_CREATE_SHELL_SELECTION_RUNTIME_CAPABILITY
    )
  } catch (error) {
    if (isRuntimeCompatBlockError(error)) {
      throw error
    }
    // Why: a failed probe created nothing, so the old-host typed-command create is still safe.
    return false
  }
}

/** Only terminal.create takes a shell; session.tabs.createTerminal has no such field. */
export async function createHostShellTerminal(
  callEnvironment: ReturnType<typeof captureRuntimeEnvironmentCall>,
  worktreeId: string,
  shell: string
): Promise<{ tabId?: string; leafId?: string }> {
  const { terminal } = readCreatedAgentTerminalIdentity(
    unwrapRuntimeRpcResult(
      await callEnvironment({
        method: 'terminal.create',
        params: {
          worktree: toRuntimeWorktreeSelector(worktreeId),
          // Why no presentation: the host's window then gets the tab, unfocused, as
          // session.tabs.createTerminal gives it; 'background' would leave it main-only.
          shell
        },
        timeoutMs: 15_000
      })
    )
  )
  return { tabId: terminal.tabId, leafId: createdTerminalLeafId(terminal) }
}
