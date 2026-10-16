import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cancelPendingClaudeSessionMoves,
  findMovableClaudeSessions,
  moveClaudeSessionsToSelectedAccount
} from './claude-session-account-move'
import { offerToMoveRunningClaudeSessions } from './claude-session-move-prompt'

type ToastOptions = { action: { onClick: () => void }; cancel: { label: string } }

const toastInfo = vi.hoisted(() => vi.fn<(title: string, options: ToastOptions) => void>())
vi.mock('sonner', () => ({ toast: { info: toastInfo, dismiss: vi.fn() } }))
vi.mock('./claude-session-account-move', () => ({
  cancelPendingClaudeSessionMoves: vi.fn(),
  findMovableClaudeSessions: vi.fn(),
  moveClaudeSessionsToSelectedAccount: vi.fn()
}))

const ARGS = {
  owner: { kind: 'local' } as const,
  target: { runtime: 'host' } as const,
  nextAccountLabel: 'b@example.com'
}
const candidate = (n: number) => ({ ptyId: `pty-${n}`, tabId: `tab-${n}`, leafId: `leaf-${n}` })

describe('offerToMoveRunningClaudeSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('stays silent when no running Claude session can move', async () => {
    vi.mocked(findMovableClaudeSessions).mockResolvedValue([])

    expect(await offerToMoveRunningClaudeSessions(ARGS)).toBe('none')
    expect(toastInfo).not.toHaveBeenCalled()
    expect(cancelPendingClaudeSessionMoves).toHaveBeenCalled()
  })

  it('offers one action that moves every session', async () => {
    const candidates = [candidate(1), candidate(2)]
    vi.mocked(findMovableClaudeSessions).mockResolvedValue(candidates)

    expect(await offerToMoveRunningClaudeSessions(ARGS)).toBe('offered')

    const [title, options] = toastInfo.mock.calls[0]
    expect(title).toBe('Move 2 running Claude sessions to b@example.com?')
    expect(options.cancel.label).toBe('Not now')
    options.action.onClick()
    expect(moveClaudeSessionsToSelectedAccount).toHaveBeenCalledWith(candidates)
  })

  it('ignores a stale prompt once a newer switch has been made', async () => {
    vi.mocked(findMovableClaudeSessions).mockResolvedValue([candidate(1)])
    await offerToMoveRunningClaudeSessions(ARGS)
    const staleOptions = toastInfo.mock.calls[0][1]

    vi.mocked(findMovableClaudeSessions).mockResolvedValue([])
    await offerToMoveRunningClaudeSessions(ARGS)
    staleOptions.action.onClick()

    expect(moveClaudeSessionsToSelectedAccount).not.toHaveBeenCalled()
  })
})
