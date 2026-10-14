import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { RuntimeMobileSessionCreateTerminalResult } from '../../../shared/runtime-types'
import { toHostSessionTabId } from '../../../shared/terminal-surface-id'
import { unwrapRuntimeRpcResult } from './runtime-rpc-result'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import type { captureRuntimeEnvironmentCall } from './web-runtime-session-environment'
import type { CreateWebRuntimeSessionTerminalArgs } from './web-runtime-session-types'

/** A plain (non-agent) terminal created through the host's session-tab flow. */
export async function createSessionTabsTerminal(
  callEnvironment: ReturnType<typeof captureRuntimeEnvironmentCall>,
  args: CreateWebRuntimeSessionTerminalArgs
): Promise<RuntimeMobileSessionCreateTerminalResult> {
  const response = await callEnvironment({
    method: 'session.tabs.createTerminal',
    params: {
      worktree: toRuntimeWorktreeSelector(args.worktreeId),
      afterTabId: args.afterTabId ? toHostSessionTabId(args.afterTabId) : undefined,
      targetGroupId: args.targetGroupId,
      // Compat: a host before #20825 runs only its default shell, so a picked shell reaches it as
      // a command typed into that shell. Delete once every supported host advertises
      // terminal.create-shell-selection.v1.
      command: args.shell ?? args.command,
      cwd: args.cwd,
      ...(args.env ? { env: args.env } : {}),
      ...(args.envToDelete ? { envToDelete: args.envToDelete } : {}),
      startupCommandDelivery: args.startupCommandDelivery,
      ...(args.launchConfig ? { launchConfig: args.launchConfig } : {}),
      ...(args.launchToken ? { launchToken: args.launchToken } : {}),
      ...(args.viewMode ? { viewMode: args.viewMode } : {}),
      // Why: old hosts understand activate:false; new hosts use select/navigation for caller-local focus.
      activate: false,
      select: args.activate !== false,
      navigation: 'caller'
    },
    timeoutMs: 15_000
  })
  return unwrapRuntimeRpcResult(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: session.tabs.createTerminal answers with RuntimeMobileSessionCreateTerminalResult; the envelope type is erased by the generic environment call.
    response as RuntimeRpcResponse<RuntimeMobileSessionCreateTerminalResult>
  )
}
