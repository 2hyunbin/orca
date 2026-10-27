/**
 * The production port of "Use on this computer again": the host's copies of the project's
 * terminals, reached over its paired runtime.
 */
import { z } from 'zod'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { WslMoveCutover } from '../../shared/wsl-move/wsl-move-cutover'
import type { Store } from '../persistence'
import { wslMoveDesktopRewriteContext } from '../persistence/moving-wsl-projects/wsl-move-desktop-rewrite'
import {
  stopWslMoveHostCopies,
  type WslMoveHostCopyStop
} from '../persistence/moving-wsl-projects/wsl-move-host-copy-stop'
import { wslMoveRewriteScope } from '../persistence/moving-wsl-projects/wsl-move-rewrite-scope'
import { wslMoveReleasedSessionFocusPatch } from '../persistence/moving-wsl-projects/wsl-move-session-rewrite'
import { applyWslMoveSessionFocus } from '../persistence/moving-wsl-projects/wsl-move-main-rewrite-stores'
import { listEnvironments } from '../../shared/runtime-environment-store'
import { callRuntimeEnvironment } from './runtime-environments/runtime-environment-transport-routing'
import {
  stopWslMoveHostAutomations,
  wslMoveAutomationsToTurnOffOnHost,
  type WslMoveHostAutomationStop
} from '../persistence/moving-wsl-projects/wsl-move-undo-host-automations'
import { disableWslHostAutomations, restoreWslHostAutomations } from './wsl-host-automation-disable'

export type WslMoveUndoPorts = {
  stopHostCopies: (move: WslMoveCutover) => Promise<WslMoveHostCopyStop>
  /** First, before the terminals stop: the host's copies of the move's automations that are on here turn off. */
  stopHostAutomations?: (move: WslMoveCutover) => Promise<WslMoveHostAutomationStop>
  /** After the release, with window writes held: focus on the host copy returns here. */
  refocusHere?: (move: WslMoveCutover) => void
}

// What undo reads of the host's terminal list: whether each terminal is still running.
const HostTerminalList = z.object({
  terminals: z.array(z.object({ connected: z.boolean() }).passthrough())
})

const SLEEP_TIMEOUT_MS = 60_000
const LIST_TIMEOUT_MS = 10_000

export function createWslMoveUndoPorts(
  store: Pick<Store, 'getWorkspaceSession' | 'patchWorkspaceSession' | 'listAutomations'>,
  userDataPath: string
): WslMoveUndoPorts {
  return {
    stopHostCopies: async (move) => {
      // A host the user removed ran its terminals down with it; nothing of the project runs there.
      if (!listEnvironments(userDataPath).some((env) => env.id === move.destinationEnvironmentId)) {
        return 'stopped'
      }
      const scope = wslMoveRewriteScope(wslMoveDesktopRewriteContext(userDataPath, move))
      const local = store.getWorkspaceSession(LOCAL_EXECUTION_HOST_ID)
      const hostIds = [...new Set(Object.keys(local.tabsByWorktree).filter(scope.inScope))].map(
        (id) => scope.worktreeId(id)
      )
      const call = async (method: string, params: unknown, timeoutMs: number) => {
        try {
          return await callRuntimeEnvironment(
            userDataPath,
            move.destinationEnvironmentId,
            method,
            params,
            timeoutMs
          )
        } catch {
          return null
        }
      }
      return stopWslMoveHostCopies(hostIds, {
        sleepWorkspace: async (id) => {
          const response = await call('worktree.sleep', { worktree: `id:${id}` }, SLEEP_TIMEOUT_MS)
          return response === null ? null : response.ok
        },
        liveTerminals: async (id) => {
          const response = await call('terminal.list', { worktree: `id:${id}` }, LIST_TIMEOUT_MS)
          if (response === null) {
            return null
          }
          // A workspace the host no longer lists runs nothing there.
          if (!response.ok) {
            return 0
          }
          const listed = HostTerminalList.safeParse(response.result)
          return listed.success
            ? listed.data.terminals.filter((terminal) => terminal.connected).length
            : 0
        },
        wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      })
    },
    stopHostAutomations: async (move) => {
      // A removed host took its automations with it.
      if (!listEnvironments(userDataPath).some((env) => env.id === move.destinationEnvironmentId)) {
        return { outcome: 'stopped', restore: async () => {} }
      }
      const environmentId = move.destinationEnvironmentId
      return stopWslMoveHostAutomations(
        wslMoveAutomationsToTurnOffOnHost(move, store.listAutomations()),
        {
          disable: (ids) => disableWslHostAutomations(userDataPath, environmentId, ids),
          restore: (ids) => restoreWslHostAutomations(userDataPath, environmentId, ids)
        }
      )
    },
    refocusHere: (move) => {
      applyWslMoveSessionFocus(
        store,
        wslMoveRewriteScope(wslMoveDesktopRewriteContext(userDataPath, move)),
        wslMoveReleasedSessionFocusPatch
      )
    }
  }
}
