import { afterEach, expect, it, vi } from 'vitest'
import { logWslSpawnOrigin, rememberSpawnCaller } from './daemon-spawn-origin-log'

afterEach(() => {
  vi.restoreAllMocks()
})

function nested(depth: number, sessionId: string): void {
  if (depth === 0) {
    rememberSpawnCaller(sessionId)
    return
  }
  nested(depth - 1, sessionId)
}

it('logs caller frames beyond the default stack limit and restores the limit', () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {})
  const limit = Error.stackTraceLimit
  nested(20, 'wsl-session')
  expect(Error.stackTraceLimit).toBe(limit)

  logWslSpawnOrigin({
    sessionId: 'wsl-session',
    wslDistro: 'Ubuntu',
    isNew: true,
    attachOnly: false,
    spawnIntent: undefined,
    coldRestore: true
  })

  const logged: { caller: string[] } = JSON.parse(String(info.mock.calls[0]?.[1]))
  expect(logged.caller.length).toBeGreaterThan(20)
  expect(logged.caller.filter((frame) => frame.includes('nested')).length).toBeGreaterThan(10)
})
