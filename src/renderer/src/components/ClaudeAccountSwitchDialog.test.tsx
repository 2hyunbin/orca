// @vitest-environment happy-dom

import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { findMovableClaudeSessions } from '@/lib/claude-session-account-move'
import {
  answerClaudeAccountSwitchPrompt,
  handleRunningClaudeSessionsAfterSwitch,
  resetClaudeAccountSwitchSessionsForTests
} from '@/lib/claude-account-switch-sessions'
import ClaudeAccountSwitchDialog from './ClaudeAccountSwitchDialog'
import type * as SwitchSessions from '@/lib/claude-account-switch-sessions'

vi.mock('@/lib/claude-session-account-move', () => ({
  findMovableClaudeSessions: vi.fn(),
  findQueuedClaudeRestartsOnAccount: () => []
}))
vi.mock('@/lib/claude-account-switch-sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof SwitchSessions>()
  return {
    ...actual,
    answerClaudeAccountSwitchPrompt: vi.fn(actual.answerClaudeAccountSwitchPrompt)
  }
})

const LEAF = (n: number): string => `0195f2ce-1111-4000-8000-00000000000${n}`
const candidate = (n: number) => ({ ptyId: `pty-${n}`, tabId: `tab-${n}`, leafId: LEAF(n) })

async function switchWith(count: number): Promise<void> {
  vi.mocked(findMovableClaudeSessions).mockResolvedValue(
    Array.from({ length: count }, (_, index) => candidate(index + 1))
  )
  await act(async () => {
    await handleRunningClaudeSessionsAfterSwitch({
      owner: { kind: 'local' },
      target: { runtime: 'host' },
      previousAccountId: 'acct-a',
      nextAccountId: 'acct-b',
      previousAccountLabel: 'a@example.com',
      nextAccountLabel: 'b@example.com'
    })
  })
}

describe('ClaudeAccountSwitchDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetClaudeAccountSwitchSessionsForTests()
  })

  afterEach(() => {
    cleanup()
  })

  it('stays closed when no session needs restarting', async () => {
    render(<ClaudeAccountSwitchDialog />)
    await switchWith(0)

    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('names both accounts and offers to restart every session', async () => {
    render(<ClaudeAccountSwitchDialog />)
    await switchWith(2)

    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText('Switched to b@example.com')).toBeTruthy()
    expect(
      screen.getByText(
        '2 Claude sessions are still running on a@example.com. Restarting continues each conversation on b@example.com. Busy sessions wait for idle before restarting.'
      )
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Keep as is' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Restart 2 sessions' })).toBeTruthy()
  })

  it('uses singular copy for one session', async () => {
    render(<ClaudeAccountSwitchDialog />)
    await switchWith(1)

    expect(screen.getByRole('button', { name: 'Restart session' })).toBeTruthy()
  })

  it('answers Keep as is on Escape', async () => {
    const user = userEvent.setup()
    render(<ClaudeAccountSwitchDialog />)
    await switchWith(1)

    await user.keyboard('{Escape}')

    expect(answerClaudeAccountSwitchPrompt).toHaveBeenCalledWith('keep', { dontAskAgain: false })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it("carries Don't ask again into an Escape", async () => {
    const user = userEvent.setup()
    render(<ClaudeAccountSwitchDialog />)
    await switchWith(1)

    await user.click(screen.getByRole('checkbox', { name: /Don't ask again/ }))
    await user.keyboard('{Escape}')

    expect(answerClaudeAccountSwitchPrompt).toHaveBeenCalledWith('keep', { dontAskAgain: true })
  })

  it("passes Don't ask again with the restart answer", async () => {
    const user = userEvent.setup()
    render(<ClaudeAccountSwitchDialog />)
    await switchWith(2)

    await user.click(screen.getByRole('checkbox', { name: /Don't ask again/ }))
    await user.click(screen.getByRole('button', { name: 'Restart 2 sessions' }))

    expect(answerClaudeAccountSwitchPrompt).toHaveBeenCalledWith('restart', { dontAskAgain: true })
  })
})
