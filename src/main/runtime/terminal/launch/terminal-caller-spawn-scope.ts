import type { TerminalCreateOptions } from '../../runtime-terminal-contracts'
import type { SpawnIntent } from '../../../../shared/host-spawn-admission'

export const BACKGROUND_TERMINAL_SPAWN_FLAGS = {
  initiallyHidden: true,
  persistHostSessionBinding: true
} as const

export function callerSpawnScope(
  opts: Pick<TerminalCreateOptions, 'signal' | 'refuseSleptWorktree' | 'spawnIntent'>
): { signal?: AbortSignal; refuseSleptWorktree?: true; spawnIntent?: SpawnIntent } {
  return {
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.refuseSleptWorktree ? { refuseSleptWorktree: true } : {}),
    ...(opts.spawnIntent ? { spawnIntent: opts.spawnIntent } : {})
  }
}
