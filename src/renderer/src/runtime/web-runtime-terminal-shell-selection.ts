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

type HostCall = ReturnType<typeof captureRuntimeEnvironmentCall>
type CreatePlacement = { worktreeId: string; targetGroupId?: string }

/**
 * Only terminal.create takes a shell; session.tabs.createTerminal has no such field. Its group
 * placement follows as a move, as host-authority agent creates do.
 */
export async function createHostShellTerminal(
  callEnvironment: HostCall,
  placement: CreatePlacement,
  shell: string
): Promise<{ tabId?: string; leafId?: string }> {
  const { terminal } = readCreatedAgentTerminalIdentity(
    unwrapRuntimeRpcResult(
      await callEnvironment({
        method: 'terminal.create',
        params: {
          worktree: toRuntimeWorktreeSelector(placement.worktreeId),
          // Why no presentation: the host's window then gets the tab, unfocused, as
          // session.tabs.createTerminal gives it; 'background' would leave it main-only.
          shell
        },
        timeoutMs: 15_000
      })
    )
  )
  await moveCreatedHostTerminalToGroup(callEnvironment, placement, terminal.tabId)
  return { tabId: terminal.tabId, leafId: createdTerminalLeafId(terminal) }
}

/** terminal.* creates take no group, so the requested one is reached by a move. */
export async function moveCreatedHostTerminalToGroup(
  callEnvironment: HostCall,
  placement: CreatePlacement,
  tabId: string | undefined
): Promise<void> {
  if (!placement.targetGroupId || !tabId) {
    return
  }
  await callEnvironment({
    method: 'session.tabs.move',
    params: {
      worktree: toRuntimeWorktreeSelector(placement.worktreeId),
      tabId,
      targetGroupId: placement.targetGroupId,
      kind: 'move-to-group'
    },
    timeoutMs: 15_000
  })
}

/**
 * Compat: a host before #20825 runs only its default shell, so a picked shell reaches it as a
 * command typed into that shell. Delete once every supported host advertises
 * terminal.create-shell-selection.v1.
 */
export function sessionTabsCreateCommand(args: {
  shell?: string
  command?: string
}): string | undefined {
  return args.shell ?? args.command
}
