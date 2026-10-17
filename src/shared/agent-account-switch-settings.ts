/** What an account switch does to that agent's sessions still on the old account. */
export type AccountSwitchRunningSessions = 'ask' | 'restart' | 'keep'

export type AgentAccountSwitchSettings = {
  /** Absent means 'ask'. */
  claudeAccountSwitchRunningSessions?: AccountSwitchRunningSessions
  /** Absent means 'ask'. Separate from Claude's: a Codex restart does not wait for idle. */
  codexAccountSwitchRunningSessions?: AccountSwitchRunningSessions
}
