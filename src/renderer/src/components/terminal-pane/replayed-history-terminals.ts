// Terminals saved history was replayed into: what the user sees there is an old session, not a blank pane.
const terminalsWithReplayedHistory = new WeakSet<object>()

export function markTerminalShowsReplayedHistory(terminal: object): void {
  terminalsWithReplayedHistory.add(terminal)
}

export function terminalShowsReplayedHistory(terminal: object): boolean {
  return terminalsWithReplayedHistory.has(terminal)
}
