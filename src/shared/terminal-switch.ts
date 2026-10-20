// A chat → terminal switch's start, owned by the execution host that creates the terminal: the
// recipe names one generation and that owner, and only the owner can say the start is over.
import { readAgentProcessIdentity, type AgentProcessIdentity } from './agent-process-presence'

/** Carries the generation from the recipe to the spawn that honours it; the spawn strips it. */
export const TERMINAL_SWITCH_GENERATION_ENV = 'ORCA_TERMINAL_SWITCH_GENERATION'

/** What the owner knows of one generation. `bound` is the exact execution it created. */
export type TerminalSwitchObservation =
  | { state: 'pending' }
  | {
      state: 'bound'
      ptyId: string
      incarnationId: string
      shellPid: number | null
      /** The startup command was written or revoked; no producer can still deliver it. */
      startupSettled: boolean
    }
  | { state: 'ended' }
  | { state: 'unverifiable' }

/** The owner's answer, tagged with who answered: a different owner never speaks for this one. */
export type TerminalSwitchOwnerAnswer = { owner: string; observation: TerminalSwitchObservation }

/** The owners a provider reaches: who takes its next fresh start, and every owner's answer. */
export type TerminalSwitchOwners = {
  owner: () => Promise<string | null>
  /** `fence`: an unseen generation becomes unusable and reads ended; without it, pending. */
  observe: (generation: string, fence: boolean) => Promise<TerminalSwitchOwnerAnswer[]>
}

/** Saved on the chat a switch left, from acceptance until the owner proves the start over.
 *  Identity only: never command text, environment, credentials or a running state. */
export type TerminalSwitchDescriptor = {
  generation: string
  agent: string
  providerSessionId: string
  owner: string
  paneKey: string
  ptyId?: string
  incarnationId?: string
  shell?: AgentProcessIdentity
  processes: AgentProcessIdentity[]
}

/** The exact execution a switch's launch identity row describes; presentation binds to it. */
export type TerminalExecutionStamp = { ptyId: string; incarnationId: string }

/** A save, or a clear that names the generation it ends. */
export type TerminalSwitchWrite = TerminalSwitchDescriptor | { clear: string }

const MAX = 512
const bounded = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX

export function isTerminalSwitchDescriptor(value: unknown): value is TerminalSwitchDescriptor {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const d: Partial<Record<keyof TerminalSwitchDescriptor, unknown>> = value
  return (
    [d.generation, d.agent, d.providerSessionId, d.owner, d.paneKey].every(bounded) &&
    [d.ptyId, d.incarnationId].every((field) => field === undefined || bounded(field)) &&
    (d.shell === undefined || readAgentProcessIdentity(d.shell) !== undefined) &&
    Array.isArray(d.processes) &&
    d.processes.length <= 16 &&
    d.processes.every((process) => readAgentProcessIdentity(process) !== undefined)
  )
}
