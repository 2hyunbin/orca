import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOsc133CommandFinishedScanner } from './terminal-osc133-command-finished'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('OSC 133 terminator scanning', () => {
  it.each(['\x07', '\x1b\\'])(
    'does not repeatedly search for an absent terminator with %j',
    (end) => {
      const chunk = `\x1b]133;C${end}\x1b]133;D;0${end}\n`.repeat(128)
      const indexOf = String.prototype.indexOf
      let absentSearchChars = 0
      vi.spyOn(String.prototype, 'indexOf').mockImplementation(function (
        this: string,
        search: string,
        position?: number
      ) {
        const result = indexOf.call(this, search, position)
        if (result === -1 && (search === '\x07' || search === '\x1b\\')) {
          absentSearchChars += Math.max(0, this.length - (position ?? 0))
        }
        return result
      })
      const finished: (number | null)[] = []
      const started: number[] = []
      const scanner = createOsc133CommandFinishedScanner(
        (exitCode) => finished.push(exitCode),
        (offset) => started.push(offset)
      )

      scanner.scan(chunk)

      expect(finished).toEqual(Array.from({ length: 128 }, () => 0))
      const frameLength = `\x1b]133;C${end}\x1b]133;D;0${end}\n`.length
      expect(started).toEqual(
        Array.from({ length: 128 }, (_, index) => index * frameLength + 7 + end.length)
      )
      expect(absentSearchChars).toBeLessThanOrEqual(chunk.length)
    }
  )

  it('keeps the earliest BEL or ST and carries a split ST past unrelated escapes', () => {
    const events: (number | null)[] = []
    const scanner = createOsc133CommandFinishedScanner((exitCode) => events.push(exitCode))

    scanner.scan('\x1b]133;D;1\x1bZignored\x07\x1b]133;D;2\x1b\\\x1b]133;D;3\x1b')
    expect(events).toEqual([1, 2])
    scanner.scan('\\\x1b]133;D;4\x07')
    expect(events).toEqual([1, 2, 3, 4])
  })
})
