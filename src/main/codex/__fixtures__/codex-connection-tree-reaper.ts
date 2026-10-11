import { vi } from 'vitest'

vi.mock('../../claude/claude-agent-sdk-exit-proof', () => ({ createClaudeChildTreeReaper }))

export function createClaudeChildTreeReaper(
  child: { kill: (signal: NodeJS.Signals) => boolean },
  deps: { exited: () => boolean }
) {
  let verdict: 'exited' | 'unverifiable' = 'unverifiable'
  return {
    capture: async () => {},
    refresh: async () => {},
    reap: async () => {
      if (!deps.exited()) {
        child.kill('SIGKILL')
      }
      verdict = 'exited'
      return verdict
    },
    get treeVerdict() {
      return verdict
    }
  }
}
