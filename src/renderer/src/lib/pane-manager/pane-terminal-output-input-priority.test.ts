import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createTerminal, loadScheduler } from './pane-terminal-output-scheduler-test-harness'

vi.mock('@/lib/e2e-config', () => ({ e2eConfig: { exposeStore: false } }))
vi.mock('@/lib/crash-breadcrumb-recorder', () => ({ recordRendererCrashBreadcrumb: vi.fn() }))

const chunks = Array.from({ length: 16 }, (_, index) => String(index % 10).repeat(16 * 1024))
const bulkOptions = { foreground: true, latencySensitive: false }

describe('terminal output yields to pending renderer input', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('window', globalThis)
    vi.spyOn(performance, 'now').mockReturnValue(0)
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('yields after one slice, then resumes full batches when input clears', async () => {
    const isInputPending = vi.fn(() => true)
    vi.stubGlobal('navigator', { scheduling: { isInputPending } })
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()
    for (const chunk of chunks) {
      writeTerminalOutput(terminal, chunk, bulkOptions)
    }

    vi.advanceTimersByTime(0)
    expect(terminal.write).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(4)
    expect(terminal.write).toHaveBeenCalledTimes(2)

    isInputPending.mockReturnValue(false)
    vi.advanceTimersByTime(4)
    expect(terminal.write).toHaveBeenCalledTimes(10)
    vi.runAllTimers()
    expect(terminal.write.mock.calls.map(([data]) => data).join('')).toBe(chunks.join(''))
  })

  it('observes input arriving during a batch', async () => {
    const isInputPending = vi.fn().mockReturnValueOnce(false).mockReturnValue(true)
    vi.stubGlobal('navigator', { scheduling: { isInputPending } })
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()
    for (const chunk of chunks) {
      writeTerminalOutput(terminal, chunk, bulkOptions)
    }

    vi.advanceTimersByTime(0)
    expect(terminal.write).toHaveBeenCalledTimes(2)
  })

  it.each([undefined, {}, { scheduling: {} }, { scheduling: { isInputPending: () => false } }])(
    'preserves the normal eight-slice batch with navigator %j',
    async (navigatorValue) => {
      vi.stubGlobal('navigator', navigatorValue)
      const { writeTerminalOutput } = await loadScheduler()
      const terminal = createTerminal()
      for (const chunk of chunks) {
        writeTerminalOutput(terminal, chunk, bulkOptions)
      }

      vi.advanceTimersByTime(0)
      expect(terminal.write).toHaveBeenCalledTimes(8)
    }
  )

  it('preserves parse acknowledgements and byte order across input yields', async () => {
    vi.stubGlobal('navigator', { scheduling: { isInputPending: () => true } })
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()
    const parseCallbacks: (() => void)[] = []
    terminal.write.mockImplementation((_data, callback) => {
      if (callback) {
        parseCallbacks.push(callback)
      }
    })
    const acknowledgements = chunks.map(() => vi.fn())
    const parsed = chunks.map(() => vi.fn())
    chunks.forEach((chunk, index) => {
      writeTerminalOutput(terminal, chunk, {
        ...bulkOptions,
        ackCredit: acknowledgements[index],
        onParsed: parsed[index]
      })
    })

    vi.advanceTimersByTime(64)
    expect(terminal.write.mock.calls.map(([data]) => data).join('')).toBe(chunks.join(''))
    for (const callback of [...acknowledgements, ...parsed]) {
      expect(callback).not.toHaveBeenCalled()
    }
    for (const callback of parseCallbacks) {
      callback()
    }
    for (const callback of [...acknowledgements, ...parsed]) {
      expect(callback).toHaveBeenCalledTimes(1)
    }
  })

  it('keeps immediate typing echo responsive beside another terminal flood', async () => {
    vi.stubGlobal('navigator', { scheduling: { isInputPending: () => true } })
    const { writeTerminalOutput } = await loadScheduler()
    const flooding = createTerminal()
    const typing = createTerminal()
    for (const chunk of chunks) {
      writeTerminalOutput(flooding, chunk, bulkOptions)
    }

    writeTerminalOutput(typing, 'k', { foreground: true, latencySensitive: true })
    expect(typing.write).toHaveBeenCalledWith('k', expect.any(Function))
    expect(flooding.write).not.toHaveBeenCalled()
  })
})
