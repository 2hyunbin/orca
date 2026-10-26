import { describe, expect, it, vi } from 'vitest'
import { revealCreatedTerminal } from './terminal-create-reveal'

const launchConfig = { agentArgs: '--dangerously-skip-permissions', agentEnv: {} }

function reveal(presentation: 'background' | 'focused') {
  const notifier = {
    revealTerminalSession: vi.fn(async () => ({ tabId: 'tab' })),
    rememberAgentLaunchConfig: vi.fn()
  }
  const result = revealCreatedTerminal({
    notifier,
    workspace: { id: 'wt', path: '/repo' },
    ptyId: 'pty',
    handle: 'term_1',
    cwd: '/repo',
    launchOpts: { launchAgent: 'claude' },
    effectiveLaunchConfig: launchConfig,
    launchToken: 'token',
    presentation,
    opts: {},
    tabId: 'tab',
    leafId: 'leaf'
  })
  return { notifier, result }
}

describe('revealCreatedTerminal launch recipe', () => {
  it('tells the window the recipe of a background launch it does not reveal', () => {
    const { notifier } = reveal('background')

    expect(notifier.revealTerminalSession).not.toHaveBeenCalled()
    expect(notifier.rememberAgentLaunchConfig).toHaveBeenCalledWith({
      worktreeId: 'wt',
      tabId: 'tab',
      leafId: 'leaf',
      launchConfig,
      launchToken: 'token',
      launchAgent: 'claude'
    })
  })

  it('leaves the recipe to the reveal of a shown launch', async () => {
    const { notifier, result } = reveal('focused')
    await result

    expect(notifier.revealTerminalSession).toHaveBeenCalledWith(
      'wt',
      expect.objectContaining({ launchConfig, launchToken: 'token' })
    )
    expect(notifier.rememberAgentLaunchConfig).not.toHaveBeenCalled()
  })
})
