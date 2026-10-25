/**
 * Why bytes are written to a PTY. Every host write entry point takes one, so no producer inherits
 * a transport's default.
 * - `driving`: input that drives the run, from a person or any client, driver or agent acting on it.
 * - `orchestration`: driving input Orca's orchestration writes itself; it is not a user's draft.
 * - `launch`: bytes Orca writes to start the run: startup commands, a create-time draft or prompt.
 * - `query-reply`: the terminal's automatic answer to a query the running program made.
 */
export type TerminalInputKind = 'driving' | 'orchestration' | 'launch' | 'query-reply'

export function isDrivingInputKind(inputKind: TerminalInputKind): boolean {
  return inputKind === 'driving' || inputKind === 'orchestration'
}
