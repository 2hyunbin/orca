import { afterEach, describe, expect, it, vi } from 'vitest'
import { ownRetainedString, resetOwnRetainedStringCopier } from '../../shared/own-retained-string'
import { TerminalShellLifecycleScanner } from './terminal-shell-lifecycle-scanner'

const PRIVATE_MODE = '\x1b[?1049;2004;1000;'
const COMMAND_FINISHED = '\x1b]133;D;137;\ud800a\udfff\u0000漢'

function heapAfterGc(resetRegexInput = false): number {
  if (!('gc' in globalThis) || typeof globalThis.gc !== 'function') {
    throw new Error('The test runner must enable --expose-gc')
  }
  if (resetRegexInput) {
    // V8's process-wide last successful match can separately retain the latest source chunk.
    void /reset/.test('reset')
  }
  globalThis.gc()
  globalThis.gc()
  return process.memoryUsage().heapUsed
}

afterEach(() => {
  vi.unstubAllGlobals()
  resetOwnRetainedStringCopier()
})

describe.each([false, true])('shell lifecycle tail with Bufferless copying=%s', (withoutBuffer) => {
  it.each([
    [PRIVATE_MODE, 8 * 1024 * 1024],
    [COMMAND_FINISHED, 12 * 1024 * 1024]
  ])('does not retain consumed chunks behind pending %j', (pending, budget) => {
    resetOwnRetainedStringCopier()
    if (withoutBuffer) {
      vi.stubGlobal('Buffer', undefined)
    }
    try {
      expect(ownRetainedString(COMMAND_FINISHED)).toBe(COMMAND_FINISHED)
    } finally {
      vi.unstubAllGlobals()
    }

    const before = heapAfterGc(true)
    const scanners = Array.from({ length: 8 }, (_value, index) => {
      const scanner = new TerminalShellLifecycleScanner()
      scanner.seedOwner('shell', { alternateScreen: pending === COMMAND_FINISHED })
      scanner.scan(`${index}:${'x'.repeat(4 * 1024 * 1024)}${pending}`)
      return scanner
    })
    const retainedWithRegexInput = heapAfterGc() - before
    const retainedByScanners = heapAfterGc(true) - before

    expect(retainedWithRegexInput).toBeLessThan(budget)
    expect(retainedByScanners).toBeLessThan(2 * 1024 * 1024)
    for (const scanner of scanners) {
      expect(scanner.owner).toBe('shell')
      if (pending === PRIVATE_MODE) {
        expect(scanner.isAlternateScreenActive).toBe(false)
        expect(scanner.scan('1006h')).toEqual({})
      } else {
        expect(scanner.scan('\x07remaining')).toEqual({
          uncleanDeathTriggerEnd: 1,
          uncleanDeathTriggerStart: 0
        })
        const generation = scanner.generation
        expect(scanner.scan('remaining')).toEqual({})
        expect(scanner.generation).toBe(generation)
      }
      expect(scanner.owner).toBeUndefined()
      expect(scanner.isAlternateScreenActive).toBe(true)
    }
  })
})
