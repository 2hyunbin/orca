import type { SshConnectionStatus } from '../../../../shared/ssh-types'

// Why: a generated ~/.ssh/config can import >10k hosts; a row each made one open cost GBs of DOM.
export const SSH_STATUS_MENU_IDLE_ROW_LIMIT = 25

export type SshStatusMenuTarget = { id: string; label: string; status: SshConnectionStatus }

export type SshStatusMenuRows = {
  connected: SshStatusMenuTarget[]
  /** In-progress or failed hosts, then idle ones matching the query, up to the limit. */
  inactive: SshStatusMenuTarget[]
  /** Idle hosts matching the query that the limit left out. */
  hiddenIdleCount: number
  /** Whether any idle host matched the query; always true for an empty query with idle hosts. */
  idleMatched: boolean
}

/**
 * Live and busy hosts always get a row. Idle ones are narrowed by the menu's search and capped,
 * hosts that own projects first so the cap keeps the machines the user works on rather than the
 * top of a generated config.
 */
export function splitSshStatusMenuRows(
  targets: readonly SshStatusMenuTarget[],
  options: {
    projectHostIds?: ReadonlySet<string>
    query?: string
    idleRowLimit?: number
  } = {}
): SshStatusMenuRows {
  const { projectHostIds, idleRowLimit = SSH_STATUS_MENU_IDLE_ROW_LIMIT } = options
  const needle = (options.query ?? '').trim().toLowerCase()
  const connected: SshStatusMenuTarget[] = []
  const active: SshStatusMenuTarget[] = []
  const idleWithProjects: SshStatusMenuTarget[] = []
  const idleOthers: SshStatusMenuTarget[] = []
  for (const target of targets) {
    if (target.status === 'connected') {
      connected.push(target)
    } else if (target.status !== 'disconnected') {
      active.push(target)
    } else if (needle !== '' && !target.label.toLowerCase().includes(needle)) {
      continue
    } else if (projectHostIds?.has(target.id)) {
      idleWithProjects.push(target)
    } else {
      idleOthers.push(target)
    }
  }
  const idle = [...idleWithProjects, ...idleOthers]
  const shownIdle = idle.slice(0, idleRowLimit)
  return {
    connected,
    inactive: [...active, ...shownIdle],
    hiddenIdleCount: idle.length - shownIdle.length,
    idleMatched: idle.length > 0
  }
}
