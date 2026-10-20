// Every pane write, a client's layout.apply or a terminal main starts, goes through one guard on
// the ids it names: a closed tab never comes back and a held id is never written twice.
import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { admitPaneToSession, applyCommandToSession } from './terminal-pane-admission'

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const HOST = 'local'
const WORKTREE = 'repo-1::/workspace'
const ONE = { tabId: 'tab-1', leafId: '11111111-1111-4111-8111-111111111111' }
const TWO = { tabId: 'tab-2', leafId: '22222222-2222-4222-8222-222222222222' }

function applied(
  session: WorkspaceSessionState,
  command: Parameters<typeof applyCommandToSession>[2]
) {
  const change = applyCommandToSession(HOST, session, command)
  expect(change.value.ok).toBe(true)
  return change.session ?? session
}

/** Tab one, closed by the user; tab two, open. */
function closedAndOpen(): WorkspaceSessionState {
  let session = getDefaultWorkspaceSession()
  for (const ids of [ONE, TWO]) {
    session = applied(session, { type: 'createTerminalTab', workspace: WORKTREE, ...ids })
  }
  return applied(session, {
    type: 'closeTabs',
    workspace: WORKTREE,
    tabIds: [ONE.tabId],
    recordClose: 'user'
  })
}

const createOne = { type: 'createTerminalTab', workspace: WORKTREE, ...ONE } as const
const createInTwo = {
  ...createOne,
  leafId: '33333333-3333-4333-8333-333333333333',
  tabId: TWO.tabId
}
const splitIntoTwo = {
  type: 'splitPane',
  workspace: WORKTREE,
  tabId: TWO.tabId,
  leafId: TWO.leafId,
  direction: 'vertical',
  newLeafId: TWO.leafId
} as const

describe('the taken and closed-id guard, on both ways a pane is written', () => {
  it('refuses a create of a closed tab', () => {
    const session = closedAndOpen()
    expect(applyCommandToSession(HOST, session, createOne)).toEqual({
      value: { ok: false, code: 'tab_closed' },
      session: null
    })
    expect(admitPaneToSession(HOST, session, createOne)).toEqual({
      value: 'tab_closed',
      session: null
    })
  })

  it('refuses a create under a tab id another pane holds', () => {
    const session = closedAndOpen()
    expect(applyCommandToSession(HOST, session, createInTwo).value).toEqual({
      ok: false,
      code: 'tab_exists'
    })
    expect(admitPaneToSession(HOST, session, createInTwo)).toEqual({
      value: 'tab_exists',
      session: null
    })
  })

  it('refuses a split under a pane id another tab holds', () => {
    let session = closedAndOpen()
    session = applied(session, {
      type: 'createTerminalTab',
      workspace: WORKTREE,
      tabId: 'tab-3',
      leafId: '44444444-4444-4444-8444-444444444444'
    })
    const split = {
      ...splitIntoTwo,
      tabId: 'tab-3',
      leafId: '44444444-4444-4444-8444-444444444444'
    }
    expect(applyCommandToSession(HOST, session, split).value).toEqual({
      ok: false,
      code: 'pane_in_other_tab'
    })
    expect(admitPaneToSession(HOST, session, split)).toEqual({
      value: 'pane_in_other_tab',
      session: null
    })
  })
})
