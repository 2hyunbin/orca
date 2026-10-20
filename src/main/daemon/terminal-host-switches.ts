// The daemon's ownership of chat → terminal switch starts. A generation is held from before its
// subprocess spawns, bound to the session the moment it exists, and only that session ends it.
import { randomUUID } from 'node:crypto'
import type { TerminalSwitchOwnerAnswer } from '../../shared/terminal-switch'
import type { Session } from './session'

type HostSwitch = { state: 'pending' | 'ended' } | { state: 'bound'; session: Session }

export class TerminalHostSwitches {
  readonly owner = `daemon:${randomUUID()}`
  private readonly entries = new Map<string, HostSwitch>()

  /** Before the subprocess: a foreign owner or an already used or fenced generation refuses. */
  begin(generation: string | undefined, owner: string | undefined): void {
    if (generation === undefined) {
      return
    }
    if (owner !== this.owner || this.entries.has(generation)) {
      throw new Error('terminal_switch_generation_refused')
    }
    this.entries.set(generation, { state: 'pending' })
  }

  bind(generation: string | undefined, session: Session): void {
    if (generation !== undefined) {
      this.entries.set(generation, { state: 'bound', session })
    }
  }

  /** The subprocess never spawned, so nothing can start or deliver under this generation. */
  endUnstarted(generation: string | undefined): void {
    if (generation !== undefined && this.entries.get(generation)?.state === 'pending') {
      this.entries.set(generation, { state: 'ended' })
    }
  }

  /** An unseen generation is fenced, so a late create carrying it refuses and absence means no start. */
  observe(generation: string, fence: boolean): TerminalSwitchOwnerAnswer {
    const entry: HostSwitch = this.entries.get(generation) ?? {
      state: fence ? 'ended' : 'pending'
    }
    if (fence) {
      this.entries.set(generation, entry)
    }
    if (entry.state !== 'bound') {
      return { owner: this.owner, observation: { state: entry.state } }
    }
    const { session } = entry
    return {
      owner: this.owner,
      observation: session.isAlive
        ? {
            state: 'bound',
            ptyId: session.sessionId,
            incarnationId: session.incarnationId,
            shellPid: session.pid > 0 ? session.pid : null,
            // The startup command is queued behind the shell-ready barrier until it settles.
            startupSettled: session.shellState !== 'pending'
          }
        : { state: 'ended' }
    }
  }
}
