import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_PROMPT_BRACKETED_PASTE_END,
  AGENT_PROMPT_BRACKETED_PASTE_START,
  CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS,
  OrcaRuntimeService,
  TERMINAL_INPUT_CHUNK_MAX_BYTES,
  TERMINAL_INPUT_MAX_BYTES,
  TERMINAL_INPUT_TOO_LARGE_ERROR,
  acknowledgeAgentPromptSubmit,
  buildAgentPromptPasteBytes
} from '../orca-runtime-test-mocks.spec'
import {
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  renderGateCapMs,
  store
} from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('settles a foreground Codex prompt when launch metadata has not arrived', async () => {
    vi.useFakeTimers()
    try {
      const writes: string[] = []
      let composerReady = false
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
        write: (_ptyId, data) => {
          writes.push(data)
          if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
            setTimeout(() => {
              composerReady = true
              runtime.onPtyData('pty-bg', '\x1b[?25hcomposer rendered', Date.now())
            }, 1_200)
          }
          acknowledgeAgentPromptSubmit(runtime, 'pty-bg', data)
          return true
        },
        kill: () => true,
        getForegroundProcess: async () => 'codex'
      })
      const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)

      await expect(runtime.isTerminalRunningSettledPromptAgent(handle)).resolves.toBe(true)
      const sendPromise = runtime.sendTerminalAgentPrompt(handle, 'review this change', {
        inputKind: 'driving'
      })
      await vi.advanceTimersByTimeAsync(1_199)
      expect(writes).not.toContain('\r')
      await vi.advanceTimersByTimeAsync(1_500)
      expect(writes).not.toContain('\r')
      await vi.advanceTimersByTimeAsync(1)
      await sendPromise

      expect(composerReady).toBe(true)
      expect(writes.filter((data) => data === '\r')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('submits a silent Claude composer once after the bounded render fallback', async () => {
    vi.useFakeTimers()
    try {
      const writes: string[] = []
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
        write: (_ptyId, data) => {
          writes.push(data)
          acknowledgeAgentPromptSubmit(runtime, 'pty-bg', data)
          return true
        },
        kill: () => true,
        getForegroundProcess: async () => null
      })
      const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
        launchAgent: 'claude'
      })

      const sendPromise = runtime.sendTerminalAgentPrompt(handle, 'review this change', {
        inputKind: 'driving'
      })
      await vi.advanceTimersByTimeAsync(renderGateCapMs('review this change') - 1)
      expect(writes).not.toContain('\r')

      await vi.advanceTimersByTimeAsync(1)
      await sendPromise
      expect(writes.filter((data) => data === '\r')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives a late Codex render marker a fresh quiescence window', async () => {
    vi.useFakeTimers()
    try {
      const writes: string[] = []
      let composerReady = false
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
        write: (_ptyId, data) => {
          writes.push(data)
          if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
            setTimeout(() => runtime.onPtyData('pty-bg', '\x1b[?25h', Date.now()), 7_900)
            setTimeout(() => {
              composerReady = true
              runtime.onPtyData('pty-bg', 'final slow composer frame', Date.now())
            }, 8_100)
          }
          acknowledgeAgentPromptSubmit(runtime, 'pty-bg', data)
          return true
        },
        kill: () => true,
        getForegroundProcess: async () => null
      })
      const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
        launchAgent: 'codex'
      })

      const sendPromise = runtime.sendTerminalAgentPrompt(handle, 'review this change', {
        inputKind: 'driving'
      })
      await vi.advanceTimersByTimeAsync(8_000)
      expect(writes).not.toContain('\r')
      await vi.advanceTimersByTimeAsync(1_599)
      expect(writes).not.toContain('\r')
      await vi.advanceTimersByTimeAsync(1)
      await sendPromise
      expect(composerReady).toBe(true)
      expect(writes.filter((data) => data === '\r')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds a Claude render that never settles to one fallback submit', async () => {
    vi.useFakeTimers()
    try {
      const writes: string[] = []
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
        write: (_ptyId, data) => {
          writes.push(data)
          if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
            setTimeout(() => runtime.onPtyData('pty-bg', '\x1b[?25h', Date.now()), 100)
            for (const delay of [1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 7_000]) {
              setTimeout(
                () => runtime.onPtyData('pty-bg', `render frame ${delay}`, Date.now()),
                delay
              )
            }
          }
          acknowledgeAgentPromptSubmit(runtime, 'pty-bg', data)
          return true
        },
        kill: () => true,
        getForegroundProcess: async () => null
      })
      const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
        launchAgent: 'claude'
      })

      const sendPromise = runtime.sendTerminalAgentPrompt(handle, 'review this change', {
        inputKind: 'driving'
      })
      // The marker at 100 ms re-arms the cap, but the ingest term is absolute: a prompt this
      // small is already ingested by then, so the fallback is one flat render timeout later.
      await vi.advanceTimersByTimeAsync(100 + 8_000 - 1)
      expect(writes).not.toContain('\r')

      await vi.advanceTimersByTimeAsync(1)
      await sendPromise
      expect(writes.filter((data) => data === '\r')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('writes large agent prompt paste frames atomically before delayed submit', async () => {
    vi.useFakeTimers()
    try {
      const writes: string[] = []
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
        write: (_ptyId, data) => {
          writes.push(data)
          acknowledgeAgentPromptSubmit(runtime, 'pty-bg', data)
          return true
        },
        kill: () => true,
        getForegroundProcess: async () => null
      })
      const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
        launchAgent: 'claude'
      })
      const prompt = `${'x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES)}\ntail`

      const sendPromise = runtime.sendTerminalAgentPrompt(handle, prompt, { inputKind: 'driving' })
      await vi.runAllTimersAsync()
      const result = await sendPromise

      const pasteWrites = writes.slice(0, -1)
      expect(result.bytesWritten).toBe(
        Buffer.byteLength(`${buildAgentPromptPasteBytes(prompt)}\r`, 'utf8')
      )
      expect(writes.at(-1)).toBe('\r')
      expect(pasteWrites).toHaveLength(1)
      expect(pasteWrites.join('')).toBe(buildAgentPromptPasteBytes(prompt))
      expect(pasteWrites[0]).toContain(AGENT_PROMPT_BRACKETED_PASTE_START)
      expect(pasteWrites.at(-1)).toContain(AGENT_PROMPT_BRACKETED_PASTE_END)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects an agent prompt when the atomic paste write fails', async () => {
    vi.useFakeTimers()
    try {
      const writes: string[] = []
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
        write: (_ptyId, data) => {
          writes.push(data)
          return false
        },
        kill: () => true,
        getForegroundProcess: async () => null
      })
      const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
        launchAgent: 'claude'
      })
      const prompt = 'x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES + 1)

      const sendPromise = runtime.sendTerminalAgentPrompt(handle, prompt, { inputKind: 'driving' })
      const sendRejection = expect(sendPromise).rejects.toThrow('terminal_not_writable')
      await vi.runAllTimersAsync()

      await sendRejection
      expect(writes[0]).toContain(AGENT_PROMPT_BRACKETED_PASTE_START)
      expect(writes).toHaveLength(1)
      expect(writes).not.toContain('\r')
    } finally {
      vi.useRealTimers()
    }
  })

  it('chunks large terminal.send text before provider writes', async () => {
    const writes: string[] = []
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: (_ptyId, data) => {
        writes.push(data)
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    const text = ['x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES), 'tail'].join('')

    const result = await runtime.sendTerminal(handle, { text }, { inputKind: 'driving' })

    expect(result).toMatchObject({
      handle,
      accepted: true,
      bytesWritten: Buffer.byteLength(text, 'utf8')
    })
    expect(writes).toEqual(['x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES), 'tail'])
  })

  it('yields chunked terminal input through immediates between writes', async () => {
    const immediate = vi.spyOn(globalThis, 'setImmediate')
    try {
      const writes: string[] = []
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
        write: (_ptyId, data) => {
          writes.push(data)
          return true
        },
        kill: () => true,
        getForegroundProcess: async () => null
      })
      const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)

      const text = `${'x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES)}\nline two\nline three`
      await runtime.sendTerminal(handle, { text, enter: true }, { inputKind: 'driving' })

      expect(writes.at(-1)).toBe('\r')
      expect(writes.slice(0, -1).join('')).toBe(text)
      expect(immediate).toHaveBeenCalled()
    } finally {
      immediate.mockRestore()
    }
  })

  it('yields while validating accepted large terminal.send text before provider writes', async () => {
    const writes: string[] = []
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: (_ptyId, data) => {
        writes.push(data)
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    const text = 'é'.repeat(CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS + 1)

    vi.useFakeTimers()
    try {
      const sendPromise = runtime.sendTerminal(handle, { text }, { inputKind: 'driving' })

      expect(writes).toEqual([])

      await vi.runAllTimersAsync()
      const result = await sendPromise

      expect(result).toMatchObject({
        handle,
        accepted: true,
        bytesWritten: Buffer.byteLength(text, 'utf8')
      })
      expect(writes.length).toBeGreaterThan(1)
      expect(writes.join('')).toBe(text)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects oversized terminal.send text before provider writes', async () => {
    const writes: string[] = []
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: (_ptyId, data) => {
        writes.push(data)
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)

    await expect(
      runtime.sendTerminal(
        handle,
        { text: 'x'.repeat(TERMINAL_INPUT_MAX_BYTES + 1) },
        { inputKind: 'driving' }
      )
    ).rejects.toThrow(TERMINAL_INPUT_TOO_LARGE_ERROR)
    expect(writes).toEqual([])
  })

  it('navigates the desktop view to a terminal session when focusing its handle', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle, tabId } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      title: 'worker',
      presentation: 'background'
    })
    const navigations: unknown[] = []
    runtime.layoutCommands.views.onNavigate('desktop', (request) => navigations.push(request))

    // Why: focus keeps createTerminal's pre-minted tabId, the one baked into the pane's env.
    await expect(runtime.focusTerminal(handle)).resolves.toMatchObject({
      handle,
      tabId,
      worktreeId: TEST_WORKTREE_ID,
      navigated: true
    })
    expect(navigations).toEqual([expect.objectContaining({ workspace: TEST_WORKTREE_ID })])
  })

  it('rejects focusing an exited background terminal session', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    runtime.onPtyExit('pty-bg', 0)

    await expect(runtime.focusTerminal(handle)).rejects.toThrow('terminal_exited')
  })

  it('renames background terminal handles without requiring a visible tab', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)

    const renamed = await runtime.renameTerminal(handle, 'Worker')
    expect(renamed).toMatchObject({
      handle,
      title: 'Worker'
    })
    expect(renamed.tabId).not.toContain(':')
    await expect(runtime.showTerminal(handle)).resolves.toMatchObject({
      tabId: renamed.tabId,
      title: 'Worker'
    })
  })

  it('keeps a background terminal handle stable while reveal adoption is racing', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      title: 'worker'
    })

    await runtime.focusTerminal(handle)
    ;(runtime as unknown as { handleByPtyId: Map<string, string> }).handleByPtyId.delete('pty-bg')

    await expect(runtime.showTerminal(handle)).resolves.toMatchObject({
      handle,
      ptyId: 'pty-bg'
    })
  })
})
