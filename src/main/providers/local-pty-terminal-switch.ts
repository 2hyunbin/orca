// The in-process owner of a chat → terminal switch start. A generation is bound before any physical
// work and to the process the moment it exists, so a publication that throws later cannot hide it.
import { randomUUID } from 'node:crypto'
import type { IPty } from 'node-pty'
import type { TerminalSwitchOwnerAnswer } from '../../shared/terminal-switch'

const OWNER = `local:${randomUUID()}`

type LocalSwitch =
  | { state: 'pending' | 'ended' }
  | {
      state: 'bound'
      id: string
      incarnationId: string
      pid: number
      exited: boolean
      startupSettled: boolean
    }

const switches = new Map<string, LocalSwitch>()

export function localTerminalSwitchOwner(): string {
  return OWNER
}

/** Before any physical work: a foreign owner or an already used or fenced generation refuses. */
export function beginLocalTerminalSwitch(generation: string | undefined, owner?: string): void {
  if (generation === undefined) {
    return
  }
  if (owner !== OWNER || switches.has(generation)) {
    throw new Error('terminal_switch_generation_refused')
  }
  switches.set(generation, { state: 'pending' })
}

/** The process exists: from here only its own exit ends the switch. */
export function commitLocalTerminalSwitch(
  generation: string | undefined,
  execution: { id: string; incarnationId: string; proc: IPty }
): void {
  if (generation === undefined) {
    return
  }
  const bound: LocalSwitch = {
    state: 'bound',
    id: execution.id,
    incarnationId: execution.incarnationId,
    pid: execution.proc.pid,
    exited: false,
    startupSettled: false
  }
  switches.set(generation, bound)
  execution.proc.onExit(() => {
    bound.exited = true
  })
}

/** A start that threw before its process existed started nothing. */
export function endUnstartedLocalTerminalSwitch(generation: string | undefined): void {
  if (generation !== undefined && switches.get(generation)?.state === 'pending') {
    switches.set(generation, { state: 'ended' })
  }
}

/** The startup command was written, revoked, or never owed: nothing can still deliver it. */
export function settleLocalTerminalSwitchStartup(id: string): void {
  for (const entry of switches.values()) {
    if (entry.state === 'bound' && entry.id === id) {
      entry.startupSettled = true
    }
  }
}

/** An unseen generation is fenced, so a late start carrying it refuses and absence means no start. */
export async function observeLocalTerminalSwitch(
  generation: string,
  fence: boolean
): Promise<TerminalSwitchOwnerAnswer[]> {
  const entry: LocalSwitch = switches.get(generation) ?? { state: fence ? 'ended' : 'pending' }
  if (fence) {
    switches.set(generation, entry)
  }
  const observation =
    entry.state !== 'bound'
      ? { state: entry.state }
      : entry.exited
        ? { state: 'ended' as const }
        : {
            state: 'bound' as const,
            ptyId: entry.id,
            incarnationId: entry.incarnationId,
            shellPid: entry.pid > 0 ? entry.pid : null,
            startupSettled: entry.startupSettled
          }
  return [{ owner: OWNER, observation }]
}

export function resetLocalTerminalSwitchesForTest(): void {
  switches.clear()
}
