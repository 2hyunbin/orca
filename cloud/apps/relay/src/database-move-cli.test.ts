import { afterEach, describe, expect, it, vi } from 'vitest'
import { runMoveCli } from './database-move-cli.js'

describe('database move CLI', () => {
  afterEach(() => vi.restoreAllMocks())

  it('refuses bad flags and unknown commands before touching anything', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: string) => lines.push(line))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await runMoveCli(['copy', '--from', 'elsewhere'], {})).toBe(2)
    expect(await runMoveCli(['sync'], {})).toBe(2)
    expect(await runMoveCli(['bogus'], {})).toBe(2)
    expect(lines.map((line) => JSON.parse(line).reason)).toEqual([
      'flag_needs_primary_or_dedicated',
      'flag_needs_primary_or_dedicated'
    ])
  })

  it('names a missing credential without opening a session', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: string) => lines.push(line))
    expect(await runMoveCli(['install-tracking', '--side', 'primary'], {})).toBe(2)
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      reason: 'credential_not_configured',
      side: 'primary',
      role: 'move'
    })
  })
})
