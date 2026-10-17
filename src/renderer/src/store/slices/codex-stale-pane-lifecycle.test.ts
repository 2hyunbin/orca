import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '../index'

const A = 'a@example.com'
const B = 'b@example.com'
const C = 'c@example.com'

function switchAccount(ptyId: string, from: string, to: string): void {
  useAppStore
    .getState()
    .markCodexStalePanes([{ ptyId, previousAccountLabel: from, nextAccountLabel: to }])
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
})

describe('codex stale pane lifecycle', () => {
  it('keeps a queued Claude restart through Codex stale-pane clear, keep and settle', () => {
    const pending = (): string | undefined =>
      useAppStore.getState().pendingPaneAccountRestarts['pty-1']
    useAppStore.getState().queuePaneAccountRestarts(['pty-1'], 'claude')

    switchAccount('pty-1', A, B)
    useAppStore.getState().clearCodexStalePane('pty-1')
    expect(pending()).toBe('claude')

    switchAccount('pty-1', A, B)
    useAppStore.getState().keepCodexStalePanes(['pty-1'])
    expect(pending()).toBe('claude')

    switchAccount('pty-1', B, A)
    expect(pending()).toBe('claude')
  })

  it('drops the record when the pane returns to the account it launched under', () => {
    switchAccount('pty-1', A, B)
    switchAccount('pty-1', B, A)

    expect(useAppStore.getState().codexStalePaneByPtyId['pty-1']).toBeUndefined()
  })

  it('keeps the launch account after Keep so re-selecting it asks nothing', () => {
    switchAccount('pty-1', A, B)
    useAppStore.getState().keepCodexStalePanes(['pty-1'])

    switchAccount('pty-1', B, A)

    expect(useAppStore.getState().codexStalePaneByPtyId['pty-1']).toBeUndefined()
  })

  it('marks Keep instead of erasing the pane record', () => {
    switchAccount('pty-1', A, B)
    useAppStore.getState().keepCodexStalePanes(['pty-1'])

    expect(useAppStore.getState().codexStalePaneByPtyId['pty-1']).toEqual({
      previousAccountLabel: A,
      nextAccountLabel: B,
      kept: true
    })
  })

  it('asks again against the pane launch account when a third account is selected', () => {
    switchAccount('pty-1', A, B)
    useAppStore.getState().keepCodexStalePanes(['pty-1'])

    switchAccount('pty-1', B, C)

    // Why: over-suppressing here would silently strand the pane on A while the
    // user works under C; the labels must name the launch account, not B.
    expect(useAppStore.getState().codexStalePaneByPtyId['pty-1']).toEqual({
      previousAccountLabel: A,
      nextAccountLabel: C
    })
  })

  it('leaves Keep answered when the active account is re-marked unchanged', () => {
    switchAccount('pty-1', A, B)
    useAppStore.getState().keepCodexStalePanes(['pty-1'])

    // Why: adding an account and reauthenticating the active one both re-mark
    // live panes with the selection unchanged. Nothing about the pane moved.
    expect(
      useAppStore
        .getState()
        .markCodexStalePanes([{ ptyId: 'pty-1', previousAccountLabel: B, nextAccountLabel: B }])
    ).toEqual([])

    expect(useAppStore.getState().codexStalePaneByPtyId['pty-1']).toEqual({
      previousAccountLabel: A,
      nextAccountLabel: B,
      kept: true
    })
  })

  it('drops a queued restart when the user keeps the same pane', () => {
    switchAccount('pty-1', A, B)
    useAppStore.getState().queuePaneAccountRestarts(['pty-1'], 'codex')

    useAppStore.getState().keepCodexStalePanes(['pty-1'])

    expect(useAppStore.getState().codexStalePaneByPtyId['pty-1']).toEqual({
      previousAccountLabel: A,
      nextAccountLabel: B,
      kept: true
    })
    expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({})
  })

  it('does not ask again about a pane whose restart is already queued', () => {
    switchAccount('pty-1', A, B)
    useAppStore.getState().queuePaneAccountRestarts(['pty-1'], 'codex')

    // Why: the queued restart relaunches on whatever is selected when it runs.
    expect(
      useAppStore
        .getState()
        .markCodexStalePanes([{ ptyId: 'pty-1', previousAccountLabel: B, nextAccountLabel: C }])
    ).toEqual([])
    expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({ 'pty-1': 'codex' })
  })

  it('drops a queued restart once the pane is back on its launch account', () => {
    switchAccount('pty-1', A, B)
    useAppStore.getState().queuePaneAccountRestarts(['pty-1'], 'codex')

    switchAccount('pty-1', B, A)

    expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({})
  })

  it('leaves the map identity alone when nothing can be kept', () => {
    switchAccount('pty-1', A, B)
    const before = useAppStore.getState().codexStalePaneByPtyId

    useAppStore.getState().keepCodexStalePanes(['pty-unknown'])

    expect(useAppStore.getState().codexStalePaneByPtyId).toBe(before)
  })

  it('reports which panes are still owed a question', () => {
    expect(
      useAppStore
        .getState()
        .markCodexStalePanes([{ ptyId: 'pty-1', previousAccountLabel: A, nextAccountLabel: B }])
    ).toEqual(['pty-1'])

    // Why the caller needs this: the startup sweep suppresses a pane for the
    // rest of the session once it is told a question went up.
    expect(
      useAppStore
        .getState()
        .markCodexStalePanes([{ ptyId: 'pty-1', previousAccountLabel: B, nextAccountLabel: A }])
    ).toEqual([])
  })

  it('still deletes the record when the pane actually restarts', () => {
    switchAccount('pty-1', A, B)

    // Why: the relaunched pane genuinely runs under B, so its launch-account
    // memory must reset rather than linger and suppress a later B -> A prompt.
    useAppStore.getState().clearCodexStalePane('pty-1')

    expect(useAppStore.getState().codexStalePaneByPtyId['pty-1']).toBeUndefined()
    switchAccount('pty-1', B, A)
    expect(useAppStore.getState().codexStalePaneByPtyId['pty-1']).toEqual({
      previousAccountLabel: B,
      nextAccountLabel: A
    })
  })
})

// Why: doAddAccount has no duplicate-email check, so one OpenAI login used in
// two ChatGPT workspaces gives two accounts the same label — as does a failed
// roster read, which collapses every account to 'Codex account'.
describe('codex stale panes with colliding account labels', () => {
  const SHARED = 'shared@example.com'

  function switchAccountById(ptyId: string, from: string | null, to: string | null): void {
    useAppStore.getState().markCodexStalePanes([
      {
        ptyId,
        previousAccountLabel: SHARED,
        nextAccountLabel: SHARED,
        previousAccountId: from,
        nextAccountId: to
      }
    ])
  }

  it('asks about two different accounts that read the same', () => {
    switchAccountById('pty-1', 'account-a', 'account-b')

    expect(useAppStore.getState().codexStalePaneByPtyId['pty-1']).toEqual({
      previousAccountLabel: SHARED,
      nextAccountLabel: SHARED,
      previousAccountId: 'account-a',
      nextAccountId: 'account-b'
    })
  })

  it('still collapses A -> B -> A when the ids match', () => {
    switchAccountById('pty-1', 'account-a', 'account-b')
    switchAccountById('pty-1', 'account-b', 'account-a')

    expect(useAppStore.getState().codexStalePaneByPtyId['pty-1']).toBeUndefined()
  })

  it('collapses back to the system default the pane launched under', () => {
    switchAccountById('pty-1', null, 'account-b')
    switchAccountById('pty-1', 'account-b', null)

    expect(useAppStore.getState().codexStalePaneByPtyId['pty-1']).toBeUndefined()
  })

  it('re-asks a kept pane when a same-labelled third account is selected', () => {
    switchAccountById('pty-1', 'account-a', 'account-b')
    useAppStore.getState().keepCodexStalePanes(['pty-1'])

    switchAccountById('pty-1', 'account-b', 'account-c')

    // Why: carrying Keep on the shared label would strand the pane on
    // account-a with its prompt answered for an account it never moved to.
    expect(useAppStore.getState().codexStalePaneByPtyId['pty-1']).toEqual({
      previousAccountLabel: SHARED,
      nextAccountLabel: SHARED,
      previousAccountId: 'account-a',
      nextAccountId: 'account-c'
    })
  })
})

describe('replaceTerminalLayoutPanePtyId', () => {
  const LEAF = '11111111-1111-4111-8111-111111111111'

  it('rebinds one leaf and leaves split siblings alone', () => {
    const OTHER_LEAF = '22222222-2222-4222-8222-222222222222'
    useAppStore.setState({
      terminalLayoutsByTabId: {
        'tab-1': {
          root: null,
          activeLeafId: LEAF,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF]: 'pty-old', [OTHER_LEAF]: 'pty-sibling' }
        }
      }
    })

    useAppStore.getState().replaceTerminalLayoutPanePtyId('tab-1', LEAF, 'pty-new')

    expect(useAppStore.getState().terminalLayoutsByTabId['tab-1']?.ptyIdsByLeafId).toEqual({
      [LEAF]: 'pty-new',
      [OTHER_LEAF]: 'pty-sibling'
    })
  })

  it('does nothing for a tab with no layout', () => {
    const before = useAppStore.getState().terminalLayoutsByTabId
    useAppStore.getState().replaceTerminalLayoutPanePtyId('tab-none', LEAF, 'pty-new')
    expect(useAppStore.getState().terminalLayoutsByTabId).toBe(before)
  })
})
