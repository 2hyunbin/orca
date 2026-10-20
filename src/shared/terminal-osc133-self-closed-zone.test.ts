import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createOsc133CommandFinishedScanner } from './terminal-osc133-command-finished'

// Real OMP 18.10.3 PTY bytes for one prompt: each user bubble ends with `B C D;0` (#10923).
const OMP_TRANSCRIPT = readFileSync(
  join(__dirname, '../main/runtime/__fixtures__/omp-user-bubble-osc133-zone.txt'),
  'utf8'
)
const C = '\x1b]133;C\x07'
const D0 = '\x1b]133;D;0\x07'
const A = '\x1b]133;A\x07'
const B = '\x1b]133;B\x07'

function scanChunks(chunks: string[]): { started: number; finished: (number | null)[] } {
  const finished: (number | null)[] = []
  let started = 0
  const scanner = createOsc133CommandFinishedScanner(
    (exitCode) => finished.push(exitCode),
    () => {
      started += 1
    }
  )
  for (const chunk of chunks) {
    scanner.scan(chunk)
  }
  return { started, finished }
}

function splitEvery(text: string, size: number): string[] {
  const chunks: string[] = []
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size))
  }
  return chunks
}

describe('OSC 133 zone an app closes for itself', () => {
  it.each([1, 3, 7, 64, OMP_TRANSCRIPT.length])(
    'does not read OMP user bubbles as the command finishing (chunks of %d)',
    (size) => {
      expect(OMP_TRANSCRIPT).toContain(`\x1b]133;B\x07${C}${D0}`)
      const { started, finished } = scanChunks(splitEvery(OMP_TRANSCRIPT, size))
      expect(finished).toEqual([])
      expect(started).toBeGreaterThan(0)
    }
  )

  it('drops a zone close split across chunks', () => {
    expect(scanChunks([B, C, '\x1b]13', '3;D;0\x07']).finished).toEqual([])
  })

  it('still finishes a silent shell command right after its start', () => {
    expect(scanChunks([`${C}${D0}${A}$ `]).finished).toEqual([0])
    expect(scanChunks([C, D0, A]).finished).toEqual([0])
  })

  it("finishes a command typed after the prompt's own B", () => {
    expect(scanChunks([`${A}$ ${B}`, 'ls\r\n', `${C}${D0}${A}`]).finished).toEqual([0])
  })

  it('does not let an Orca status frame between the markers hide the zone close', () => {
    const status = '\x1b]9999;{"state":"working"}\x07'
    expect(scanChunks([`${B}${C}${status}${D0}OMP reply`]).finished).toEqual([])
    expect(
      scanChunks([`${B}${C}${status.slice(0, 9)}`, `${status.slice(9)}${D0}OMP`]).finished
    ).toEqual([])
    expect(scanChunks([`${status}${D0}OMP reply`]).finished).toEqual([])
    expect(scanChunks([`${status}${D0}${A}`]).finished).toEqual([0])
    expect(scanChunks([`$ ${C}${status}${D0}${A}`]).finished).toEqual([0])
  })

  it('finishes a failed command even straight after a zone end', () => {
    expect(scanChunks([`${B}${C}\x1b]133;D;1\x07`]).finished).toEqual([1])
  })

  it.each([0, 1, 2])(
    'does not finish a bubble whose reader changed %d markers before its D',
    (markersBeforeReset) => {
      const finished = vi.fn()
      const scanner = createOsc133CommandFinishedScanner(finished)
      const markers = [B, C, D0]
      scanner.scan(`$ ${markers.slice(0, markersBeforeReset).join('')}`)
      scanner.reset()
      scanner.scan(`${markers.slice(markersBeforeReset).join('')}OMP reply`)
      expect(finished).not.toHaveBeenCalled()
    }
  )

  it('still finishes silent, failed and interrupted commands right after a reset', () => {
    const finished = vi.fn()
    const scanner = createOsc133CommandFinishedScanner(finished)
    for (const chunks of [
      [D0, A],
      [C, `${D0}${A}`],
      ['\x1b]133;D;1\x07'],
      ['\x1b]133;D;130\x07']
    ]) {
      scanner.reset()
      chunks.forEach(scanner.scan)
    }
    expect(finished.mock.calls).toEqual([[0], [0], [1], [130]])
  })
})
