import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const nodePty = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node-pty', () => nodePty)
vi.mock('../../windows/windows-pty-job', () => ({ assignHostProcessToKillOnCloseJob: vi.fn() }))

import { spawnNativeDaemonPty } from './native-pty-spawn'

const attempts = ['pwsh.exe', 'powershell.exe', 'cmd.exe'].map((shellPath) => ({
  shellPath,
  shellArgs: [shellPath === 'cmd.exe' ? '/K' : '-NoExit'],
  effectiveCwd: 'C:\\work',
  validationCwd: 'C:\\work',
  startupCommandDeliveredInShellArgs: true
}))
const args = {
  shellPath: attempts[0]!.shellPath,
  shellArgs: attempts[0]!.shellArgs,
  spawnCwd: 'C:\\work',
  env: {},
  cols: 80,
  rows: 24,
  windowsFallbackAttempts: attempts
}

const CONPTY_PRELUDE = '\x1b[1t\x1b[c\x1b[?1004h\x1b[?9001h'

/** A pane that writes `chunks` on later ticks, as ConPTY's output socket does. */
function fakePane(pid: number, chunks: string[]) {
  const dataListeners = new Set<(data: string) => void>()
  const pane = {
    pid,
    kill: vi.fn(),
    onData: (listener: (data: string) => void) => {
      dataListeners.add(listener)
      return { dispose: () => dataListeners.delete(listener) }
    },
    onExit: () => ({ dispose: () => {} })
  }
  void (async () => {
    for (const chunk of chunks) {
      await new Promise((resolve) => setImmediate(resolve))
      for (const listener of dataListeners) {
        listener(chunk)
      }
    }
  })()
  return pane
}

describe('Windows shell fallback over node-pty ConPTY', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    nodePty.spawn.mockReset()
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', platform)
    vi.restoreAllMocks()
  })

  it('walks both fallback shells when ConPTY rejects the primary ones', async () => {
    const proc = fakePane(9876, [CONPTY_PRELUDE])
    nodePty.spawn.mockImplementation((file: string) => {
      if (file !== 'cmd.exe') {
        throw new Error(`spawn ${file} EACCES`)
      }
      return proc
    })
    const result = await spawnNativeDaemonPty(args)
    expect(nodePty.spawn.mock.calls.map(([file]) => file)).toEqual([
      'pwsh.exe',
      'powershell.exe',
      'cmd.exe'
    ])
    expect(nodePty.spawn.mock.calls[2]![2]).toMatchObject({ useConptyDll: true })
    expect(result.process).toBe(proc)
    expect(result.shellPath).toBe('cmd.exe')
    expect(result.startupCommandDeliveredInShellArgs).toBe(true)
  })

  it('respawns a pane whose ConPTY never started reading input', async () => {
    // Measured on CI: such a pane prints its banner and prompt, then ignores every keystroke.
    const broken = fakePane(1, ['Microsoft Windows [Version 10.0.20348]\r\n'])
    const healthy = fakePane(2, ['\x1b[1t', '\x1b[c\x1b[?1004h', 'Microsoft Windows'])
    nodePty.spawn.mockReturnValueOnce(broken).mockReturnValueOnce(healthy)

    const result = await spawnNativeDaemonPty(args)

    expect(nodePty.spawn.mock.calls.map(([file]) => file)).toEqual(['pwsh.exe', 'pwsh.exe'])
    expect(broken.kill).toHaveBeenCalledOnce()
    expect(result.process).toBe(healthy)
    expect(result.shellPath).toBe('pwsh.exe')
    expect(result.claimStartupEvents?.().data).toEqual(['\x1b[1t', '\x1b[c\x1b[?1004h'])
  })

  it('starts no fallback shell once the spawn is canceled', async () => {
    const controller = new AbortController()
    nodePty.spawn.mockImplementation(() => {
      controller.abort(new Error('spawn canceled'))
      throw new Error('spawn pwsh.exe EACCES')
    })
    await expect(spawnNativeDaemonPty({ ...args, signal: controller.signal })).rejects.toThrow(
      'spawn canceled'
    )
    expect(nodePty.spawn).toHaveBeenCalledOnce()
  })
})
