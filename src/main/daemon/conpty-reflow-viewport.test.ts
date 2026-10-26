import { describe, expect, it } from 'vitest'
import { HeadlessEmulator } from './headless-emulator'

const WIDE = 120
const NARROW = 40
const ROWS = 10

/** A ConPTY screen whose history holds rows that rejoin when it widens, so widening corrects. */
function conptyScreenNeedingWidenCorrection(): HeadlessEmulator {
  const emulator = new HeadlessEmulator({
    cols: NARROW,
    rows: ROWS,
    windowsPty: { backend: 'conpty', buildNumber: 26100 }
  })
  const rows = Array.from({ length: 30 }, (_, i) => `${'x'.repeat(70)} line ${i}`)
  emulator.writeSync(`${rows.join('\r\n')}\r\n$ `)
  return emulator
}

function screenText(emulator: HeadlessEmulator): string {
  return emulator.getVisibleLines().join('\n')
}

describe('ConPTY resize correction while an escape sequence is unfinished', () => {
  it('leaves a split SGR whole, so its tail is never printed as text', async () => {
    const emulator = conptyScreenNeedingWidenCorrection()
    await emulator.write('\x1b[3')
    emulator.resize(WIDE, ROWS)
    await emulator.write('1mRED\x1b[0m')
    const text = screenText(emulator)
    expect(text).toContain('$ RED')
    expect(text).not.toContain('1mRED')
    emulator.dispose()
  })

  it('leaves a split OSC title whole, so its tail is never printed as text', async () => {
    const emulator = conptyScreenNeedingWidenCorrection()
    await emulator.write('\x1b]0;my ti')
    emulator.resize(WIDE, ROWS)
    await emulator.write('tle\x07done')
    const text = screenText(emulator)
    expect(text).toContain('$ done')
    expect(text).not.toContain('tle')
    emulator.dispose()
  })
})
