import './mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { Terminal } from '@xterm/headless'
import { HistoryReader } from './history-reader'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { DaemonServer } from './daemon-server'
import { createMockSubprocess, startDaemonAdapterHarness } from './daemon-pty-adapter-test-harness'
import type * as DaemonHealthModule from './daemon-health'
import type * as DaemonTccAttributionModule from './daemon-tcc-attribution'

const { getMacDaemonSystemResolverHealthMock, getMacDaemonTccAttributionHealthMock } = vi.hoisted(
  () => ({
    getMacDaemonSystemResolverHealthMock: vi.fn(
      async (): Promise<'unknown' | 'unhealthy'> => 'unknown'
    ),
    getMacDaemonTccAttributionHealthMock: vi.fn(
      async (): Promise<'intact' | 'severed' | 'unknown'> => 'unknown'
    )
  })
)

vi.mock('./daemon-health', async (importOriginal) => {
  const actual = await importOriginal<typeof DaemonHealthModule>()
  return {
    ...actual,
    getMacDaemonSystemResolverHealth: getMacDaemonSystemResolverHealthMock
  }
})

vi.mock('./daemon-tcc-attribution', async (importOriginal) => {
  const actual = await importOriginal<typeof DaemonTccAttributionModule>()
  return {
    ...actual,
    getMacDaemonTccAttributionHealth: getMacDaemonTccAttributionHealthMock
  }
})

async function conptyRepaintAfterResize(
  output: string,
  [fromCols, fromRows]: [number, number],
  [toCols, toRows]: [number, number]
): Promise<string> {
  const conpty = new Terminal({
    cols: fromCols,
    rows: fromRows,
    scrollback: 0,
    allowProposedApi: true
  })
  await new Promise<void>((resolve) => conpty.write(output, resolve))
  conpty.resize(toCols, toRows)
  const screen: string[] = []
  for (let row = 0; row < toRows; row++) {
    screen.push(`${conpty.buffer.active.getLine(row)?.translateToString(true) ?? ''}\x1b[K`)
  }
  const cursor = `\x1b[${conpty.buffer.active.cursorY + 1};${conpty.buffer.active.cursorX + 1}H`
  conpty.dispose()
  return `\x1b[H${screen.join('\r\n')}${cursor}`
}

/** Drives the adapter's own periodic save, which has no public trigger. */
class SavingDaemonPtyAdapter extends DaemonPtyAdapter {
  savePeriodically(sessionIds: string[]): Promise<unknown> {
    return this.checkpointSessions(sessionIds, { final: false })
  }
}

describe('daemon history of a ConPTY session through a resize', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let server: DaemonServer
  let adapter: DaemonPtyAdapter
  let lastSubprocess: ReturnType<typeof createMockSubprocess>

  beforeEach(async () => {
    const harness = await startDaemonAdapterHarness(() => {
      lastSubprocess = createMockSubprocess()
      return lastSubprocess
    })
    dir = harness.dir
    socketPath = harness.socketPath
    tokenPath = harness.tokenPath
    server = harness.server
    adapter = harness.adapter
    getMacDaemonSystemResolverHealthMock.mockReset()
    getMacDaemonSystemResolverHealthMock.mockResolvedValue('unknown')
    getMacDaemonTccAttributionHealthMock.mockReset()
    getMacDaemonTccAttributionHealthMock.mockResolvedValue('unknown')
  })

  afterEach(async () => {
    adapter?.dispose()
    await server?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })
  // awin verify-15a: Sleep, Wake, quit and relaunch, then Sleep put the new prompt on the old one.
  it('restores a widened ConPTY session from its checkpoint and log with no lost or doubled rows', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      const historyDir = join(dir, 'history')
      const sessionId = 'wt-1::/project@@widen1'
      const history = new SavingDaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
      await history.spawn({ cols: 40, rows: 10, cwd: '/project', sessionId })
      await history.savePeriodically([sessionId])
      // Rows that wrap at 40 columns and rejoin at 120: widening pulls rows out of scrollback.
      const output = `${Array.from({ length: 30 }, (_, i) => `${'x'.repeat(70)} L${i}`).join('\r\n')}\r\n$ `
      lastSubprocess._simulateData(output)
      await history.savePeriodically([sessionId])
      history.resize(sessionId, 120, 10)
      // ConPTY keeps no scrollback: it repaints from the top only the screen it still holds.
      lastSubprocess._simulateData(await conptyRepaintAfterResize(output, [40, 10], [120, 10]))
      await history.savePeriodically([sessionId])

      const restored = await new HistoryReader(historyDir).detectColdRestore(sessionId, {
        ignoreCleanEnd: true
      })
      expect(restored).not.toBeNull()
      const terminal = new Terminal({
        cols: 120,
        rows: 10,
        scrollback: 5000,
        allowProposedApi: true
      })
      await new Promise<void>((resolve) => terminal.write(restored!.snapshotAnsi, resolve))
      const labels: string[] = []
      for (let i = 0; i < terminal.buffer.active.length; i++) {
        const match = /L(\d+)$/.exec(
          terminal.buffer.active.getLine(i)?.translateToString(true) ?? ''
        )
        if (match) {
          labels.push(`L${match[1]}`)
        }
      }
      terminal.dispose()
      expect(labels).toEqual(Array.from({ length: 30 }, (_, i) => `L${i}`))
      history.dispose()
    } finally {
      if (original) {
        Object.defineProperty(process, 'platform', original)
      }
    }
  })
})
