import type { SshConnectionStatus } from '../../../../shared/ssh-types'

// Why: a generated ~/.ssh/config can import >10k hosts; a row each made one open cost GBs of DOM.
export const SSH_STATUS_MENU_IDLE_ROW_LIMIT = 15

export type SshStatusMenuTarget = { id: string; label: string; status: SshConnectionStatus }

export type SshStatusMenuRows = {
  connected: SshStatusMenuTarget[]
  /** In-progress or failed hosts, then the first idle ones up to the limit. */
  inactive: SshStatusMenuTarget[]
  hiddenIdleCount: number
}

export function splitSshStatusMenuRows(
  targets: readonly SshStatusMenuTarget[],
  idleRowLimit = SSH_STATUS_MENU_IDLE_ROW_LIMIT
): SshStatusMenuRows {
  const connected: SshStatusMenuTarget[] = []
  const active: SshStatusMenuTarget[] = []
  const idle: SshStatusMenuTarget[] = []
  let hiddenIdleCount = 0
  for (const target of targets) {
    if (target.status === 'connected') {
      connected.push(target)
    } else if (target.status !== 'disconnected') {
      active.push(target)
    } else if (idle.length < idleRowLimit) {
      idle.push(target)
    } else {
      hiddenIdleCount += 1
    }
  }
  return { connected, inactive: [...active, ...idle], hiddenIdleCount }
}
