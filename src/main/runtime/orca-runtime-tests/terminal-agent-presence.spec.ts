import { describe, expect, it, vi } from 'vitest'
import { committingSpawn } from '../bind-first-pane.test-fixture'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import { TEST_WORKTREE_PATH, store } from '../orca-runtime-test-fixtures.spec'
import { assertTerminalRunsAgent } from '../rpc/methods/orchestration/worker/explicit-worker-terminal-validation'

// Claude answered over OSC 7501 paints no title glyph, and macOS p_comm names the native
// install by its version directory: the shape of an idle Claude worker in STA-11772.
const PLAIN_TITLE = '\x1b]0;Orca worker dispatch task ok\x07'
const PROGRAM_IDLE = '\x1b]7501;state=idle:app=claude-code\x1b\\'
const SHELL_PROMPT = '\x1b]133;A\x07'

async function claudeTerminal(foreground: {
  cached: string | null
  confirm?: (ptyId: string) => Promise<string | null>
}): Promise<{ runtime: OrcaRuntimeService; handle: string }> {
  const spawn = vi.fn().mockResolvedValue({ id: 'pty-claude' })
  const runtime = new OrcaRuntimeService(store)
  runtime.setPtyController({
    spawn: committingSpawn(runtime, spawn),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => foreground.cached,
    confirmForegroundProcess: foreground.confirm
  })
  const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
    command: 'claude',
    title: 'worker'
  })
  return { runtime, handle }
}

describe('terminal agent presence', () => {
  it('finds an idle Claude by its launch name when p_comm is its version directory', async () => {
    const { runtime, handle } = await claudeTerminal({
      cached: '2.1.310',
      confirm: async () => 'claude'
    })
    runtime.onPtyData('pty-claude', PLAIN_TITLE, 1)

    await expect(runtime.resolveTerminalAgentPresence(handle)).resolves.toBe('present')
  })

  it("takes the program's own status where the process read cannot name the agent", async () => {
    const { runtime, handle } = await claudeTerminal({ cached: '2.1.310' })
    runtime.onPtyData('pty-claude', PLAIN_TITLE + PROGRAM_IDLE, 1)

    await expect(runtime.resolveTerminalAgentPresence(handle)).resolves.toBe('present')
  })

  it('reports a clean exit to the shell as absent', async () => {
    const { runtime, handle } = await claudeTerminal({ cached: 'zsh' })
    runtime.onPtyData('pty-claude', PLAIN_TITLE + PROGRAM_IDLE, 1)
    runtime.onPtyData('pty-claude', SHELL_PROMPT, 2)

    await expect(runtime.resolveTerminalAgentPresence(handle)).resolves.toBe('absent')
  })

  it('lets a shell in the foreground outrank the status a killed agent left behind', async () => {
    const confirmForegroundProcess = vi.fn(async () => 'zsh')
    const { runtime, handle } = await claudeTerminal({
      cached: 'zsh',
      confirm: confirmForegroundProcess
    })
    runtime.onPtyData('pty-claude', PLAIN_TITLE + PROGRAM_IDLE, 1)

    await expect(runtime.resolveTerminalAgentPresence(handle)).resolves.toBe('absent')
    // A Windows tracker answers with the shell until its scan lands, so the shell is re-read.
    expect(confirmForegroundProcess).toHaveBeenCalledOnce()
  })

  it('refuses an unreadable foreground with a reason, keeping the existing error code', async () => {
    const { runtime, handle } = await claudeTerminal({ cached: null })
    runtime.onPtyData('pty-claude', PLAIN_TITLE, 1)

    await expect(assertTerminalRunsAgent(runtime, handle)).rejects.toMatchObject({
      code: 'agent_unconfigured',
      data: { reason: 'foreground_process_unreadable' }
    })
  })
})
