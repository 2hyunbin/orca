import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import { createAppState } from '@/store'
import { getAgentStatusOwner } from '@/store/agent-status-commit'
import type { AgentStatusEntry } from '@/store/slices/agent-status'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { Tab } from '../../../shared/tab-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { getTabAgentExitOwner } from './tab-agent-exit-owner'

const leaf = '11111111-1111-4111-8111-111111111111'
const pane = makePaneKey('tab', leaf)
const tab: TerminalTab = {
  id: 'tab',
  worktreeId: 'workspace',
  ptyId: 'pty-a',
  title: 'zsh',
  launchAgent: 'codex',
  customTitle: null,
  color: null,
  sortOrder: 0,
  createdAt: 0
}
const row = (state: AgentStatusEntry['state']): AgentStatusEntry => ({
  paneKey: pane,
  agentType: 'codex',
  state,
  prompt: 'task',
  stateHistory: [],
  stateStartedAt: 10,
  updatedAt: 20
})
function setup(titles?: readonly string[]) {
  const store = createStore(createAppState)
  const status = getAgentStatusOwner(store)
  const items: Tab[] = (titles ?? []).map((label, n) => ({
    id: `item-${n}`,
    entityId: tab.id,
    contentType: 'terminal',
    worktreeId: tab.worktreeId,
    groupId: `g${n}`,
    label,
    customLabel: null,
    color: null,
    sortOrder: n,
    createdAt: 0
  }))
  store.setState({
    tabsByWorktree: { workspace: [tab] },
    ptyIdsByTabId: { tab: ['pty-a'] },
    terminalLayoutsByTabId: {
      tab: {
        root: { type: 'leaf', leafId: leaf },
        activeLeafId: leaf,
        expandedLeafId: null,
        ptyIdsByLeafId: { [leaf]: 'pty-a' }
      }
    },
    unifiedTabsByWorktree: { workspace: items },
    layoutByWorktree: titles
      ? {
          workspace: {
            type: 'split',
            direction: 'horizontal',
            ratio: 0.5,
            first: { type: 'leaf', groupId: 'g0' },
            second: { type: 'leaf', groupId: 'g1' }
          }
        }
      : {}
  })
  const service = getTabAgentExitOwner(status)
  const stop = service.start()
  stops.push(stop)
  return { store, status, service, stop }
}
const stops: (() => void)[] = []
afterEach(() => {
  for (const stop of stops.splice(0)) {
    stop()
  }
  vi.restoreAllMocks()
})

describe('root terminal exit evidence on captured canonical pairs', () => {
  it.each([
    ['codex', 'zsh'],
    ['zsh', 'codex']
  ])('keeps duplicate saved group histories independent: %s/%s', (...titles) => {
    const { store, service } = setup(titles)
    const clear = vi.fn(store.getState().clearTabLaunchAgent)
    store.setState({ clearTabLaunchAgent: clear })
    expect(clear).not.toHaveBeenCalled()
    expect(service.getObservation('workspace', 'tab', 'g0')).toBe(titles[0] === 'codex')
    expect(service.getObservation('workspace', 'tab', 'g1')).toBe(titles[1] === 'codex')
    store.getState().updateTabTitle('tab', 'codex running')
    expect(clear).not.toHaveBeenCalled()
    const current = store.getState()
    const signalled = titles.indexOf('codex')
    store.setState({
      unifiedTabsByWorktree: {
        workspace: current.unifiedTabsByWorktree.workspace.map((item, index) =>
          index === signalled ? { ...item, label: 'zsh' } : item
        )
      }
    })
    expect(clear).toHaveBeenCalledTimes(1)
    expect(store.getState().tabsByWorktree.workspace[0].launchAgent).toBeUndefined()
  })

  it('retains a completion followed by recursive row removal, without a mounted hook', () => {
    const { store, status, service } = setup()
    const clear = vi.fn(store.getState().clearTabLaunchAgent)
    store.setState({ clearTabLaunchAgent: clear })
    let removed = false
    store.subscribe(() => {
      if (status.getEntry(pane)?.state === 'done' && !removed) {
        removed = true
        status.transact((transaction) => transaction.setEntry(pane, undefined))
        expect(status.getEntry(pane)).toBeUndefined()
        expect(clear).not.toHaveBeenCalled()
      }
    })
    status.transact((transaction) => {
      transaction.setEntry(pane, row('done'))
      store.setState({ agentStatusEpoch: store.getState().agentStatusEpoch + 1 })
    })
    expect(removed).toBe(true)
    expect(clear).toHaveBeenCalledTimes(1)
    expect(service.getObservation('workspace', 'tab')).toBe(true)
  })

  it.each(['working', 'replacement'] as const)(
    'cannot clear a newer %s runtime during recursive delivery',
    (kind) => {
      const { store, status } = setup()
      const clear = vi.fn(store.getState().clearTabLaunchAgent)
      store.setState({ clearTabLaunchAgent: clear })
      let changed = false
      store.subscribe(() => {
        if (status.getEntry(pane)?.state === 'done' && !changed) {
          changed = true
          if (kind === 'working') {
            status.transact((transaction) => transaction.setEntry(pane, row('working')))
          } else {
            store.setState({ tabsByWorktree: { workspace: [{ ...tab, title: 'codex new' }] } })
          }
        }
      })
      status.transact((transaction) => {
        transaction.setEntry(pane, row('done'))
        store.setState({ agentStatusEpoch: 1 })
      })
      expect(changed).toBe(true)
      expect(clear).not.toHaveBeenCalled()
      expect(store.getState().tabsByWorktree.workspace[0].launchAgent).toBe('codex')
    }
  )
})
