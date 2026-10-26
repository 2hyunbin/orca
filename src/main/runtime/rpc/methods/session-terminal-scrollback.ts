import { SessionReadTerminalScrollbackParams } from '../../../../shared/rpc-contract/session-terminal-scrollback-params'
import { defineMethod } from '../core'
import { servesWslMovedPaneHistory } from '../../../orcad/orcad-migration-wsl-destination'

export const SESSION_TERMINAL_SCROLLBACK_METHODS = [
  // Gated by session.terminal-scrollback-read.v1: older hosts answer method-not-found.
  defineMethod({
    name: 'session.readTerminalScrollback',
    permission: 'workspace',
    params: SessionReadTerminalScrollbackParams,
    handler: async (params, { runtime }) =>
      runtime.readTerminalScrollbackForClient({ worktree: params.worktree, ref: params.ref })
  })
]

/** Only a WSL host serves moved panes' stored scrollback; every other host answers method-not-found. */
export function sessionTerminalScrollbackMethodsForThisHost(): typeof SESSION_TERMINAL_SCROLLBACK_METHODS {
  return servesWslMovedPaneHistory() ? SESSION_TERMINAL_SCROLLBACK_METHODS : []
}
