import { describe, expect, it, vi } from 'vitest'
import { runLayoutPaneStarts, type LayoutPaneStartPorts } from './layout-command-pane-starts'

const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `tab-1:${LEAF}`

function ports(overrides: Partial<LayoutPaneStartPorts> = {}): LayoutPaneStartPorts {
  return {
    start: vi.fn(async () => 'pty-1'),
    stop: vi.fn(() => true),
    ...overrides
  }
}

describe('runLayoutPaneStarts', () => {
  it('restarts by stopping, then starting through the starter', async () => {
    const run = ports()
    runLayoutPaneStarts(
      { type: 'restartPane', workspace: 'wt' },
      { stopPtyIds: ['pty-old'], startPaneKeys: [PANE_KEY] },
      run
    )
    expect(run.stop).toHaveBeenCalledWith('pty-old')
    expect(run.start).toHaveBeenCalledWith({ worktreeId: 'wt', tabId: 'tab-1', leafId: LEAF })
    await vi.waitFor(() => expect(run.start).toHaveBeenCalledOnce())
  })

  it('starts nothing when a restart could not stop its terminal, and says so', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const run = ports({ stop: vi.fn(() => false) })
    runLayoutPaneStarts(
      { type: 'restartPane', workspace: 'wt' },
      { stopPtyIds: ['pty-old'], startPaneKeys: [PANE_KEY] },
      run
    )
    expect(run.start).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('runs no start for a create, which starts through its own path', () => {
    const run = ports()
    runLayoutPaneStarts(
      { type: 'createTerminalTab', workspace: 'wt' },
      { stopPtyIds: [], startPaneKeys: [PANE_KEY] },
      run
    )
    expect(run.start).not.toHaveBeenCalled()
  })
})
