import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import { useAppStore } from '../store'
import { selectKnownWorktreeById } from '../store/selectors'
import { unwrapRuntimeRpcResult } from './runtime-rpc-result'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import type { captureRuntimeEnvironmentCall } from './web-runtime-session-environment'
import {
  createdTerminalLeafId,
  readCreatedAgentTerminalIdentity
} from './web-runtime-terminal-identity'

/**
 * Whether the workspace's host listed this shell as one its terminal.create honours. A host that
 * sends no list (older than this field) gets the typed-command compat create instead.
 */
export function hostHonoursWorktreeShell(
  environmentId: string,
  worktreeId: string,
  shell: string
): boolean {
  const worktree = selectKnownWorktreeById(
    useAppStore.getState(),
    worktreeId,
    toRuntimeExecutionHostId(environmentId)
  )
  return worktree?.windowsTerminalShells?.includes(shell) === true
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
