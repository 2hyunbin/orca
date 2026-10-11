import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const WORKSPACE_TAB_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['tab', 'list'],
    summary: 'List every Orca tab in a worktree: terminals, chats, editors and browsers',
    usage: 'orca tab list [--worktree <selector|all>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree'],
    notes: [
      'Each row starts with its tab id. A split terminal is one row listing all its terminal handles.',
      'Browser rows carry browserPageId, the id page commands take with --page.'
    ],
    examples: ['orca tab list', 'orca tab list --worktree all --json']
  }
]
