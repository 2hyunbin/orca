import { RuntimeTerminalIdlePolls } from '../terminal/wait/terminal-idle-polls'
import type { TuiIdleEvidenceSource } from '../tui-idle-evidence-source'
import { TUI_IDLE_POLL_INTERVAL_MS } from '../orca-runtime-postlude'
import { hasTerminalCommandPainted } from '../terminal-command-paint'
import type { SessionLifecyclePorts } from './session-lifecycle-ports'

export function createSessionTerminalIdlePolls(
  evidence: TuiIdleEvidenceSource,
  sessions: Pick<
    SessionLifecyclePorts,
    'getPtyController' | 'getPty' | 'state' | 'getLeafKey' | 'getWaiters' | 'bindRuntimeMethod'
  >,
  readVisibleScreen: ConstructorParameters<typeof RuntimeTerminalIdlePolls>[0]['readVisibleScreen']
): RuntimeTerminalIdlePolls {
  return new RuntimeTerminalIdlePolls({
    ...evidence,
    intervalMs: TUI_IDLE_POLL_INTERVAL_MS,
    getForegroundProcess: (ptyId) =>
      sessions.getPtyController()?.getForegroundProcess(ptyId) ?? null,
    hasCommandPainted: (ptyId) => {
      const pty = sessions.getPty(ptyId)
      return pty === undefined || hasTerminalCommandPainted(pty)
    },
    readVisibleScreen,
    getLiveLeaf: (leaf) =>
      sessions.state.leaves.get(
        sessions.bindRuntimeMethod(sessions.getLeafKey())(leaf.tabId, leaf.leafId)
      ) ?? leaf,
    resolve: (waiter, result) => sessions.getWaiters().resolve(waiter, result)
  })
}
