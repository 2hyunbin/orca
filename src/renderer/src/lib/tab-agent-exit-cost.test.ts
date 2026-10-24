import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import { createAppState } from '@/store'
import { getAgentStatusOwner } from '@/store/agent-status-commit'
import { makeTab, makeUnifiedTab, makeWorktree } from '@/store/slices/store-test-helpers'
import type { TabGroupLayoutNode } from '../../../shared/tab-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { getTabAgentExitOwner } from './tab-agent-exit-owner'
import * as signals from './tab-agent-exit-signals'
import * as projections from './terminal-agent-evidence-scopes'
import * as routing from '@/store/terminals/terminal-workspace-routing'

const leaf = '11111111-1111-4111-8111-111111111111'
const workspace = 'repo::/worktree'
const stops: (() => void)[] = []
afterEach(() => {
  stops.splice(0).forEach((stop) => stop())
  vi.restoreAllMocks()
})

function countedRows<T>(rows: T[], count: () => void): T[] {
  rows.forEach((value, index) => {
    Object.defineProperty(rows, index, {
      get: () => {
        count()
        return value
      }
    })
  })
  return rows
}
function setup(size: number) {
  const counts = { groupLeaves: 0, rawRows: 0, unifiedRows: 0 }
  const store = createStore(createAppState),
    status = getAgentStatusOwner(store)
  const tabs = countedRows(
    Array.from({ length: size }, (_, i) =>
      makeTab({ id: `tab-${i}`, worktreeId: workspace, title: 'zsh', ptyId: `pty-${i}` })
    ),
    () => counts.rawRows++
  )
  const items = countedRows(
    tabs.map((tab, i) =>
      makeUnifiedTab({
        id: `item-${i}`,
        entityId: tab.id,
        worktreeId: workspace,
        groupId: `g${i}`,
        label: 'zsh'
      })
    ),
    () => counts.unifiedRows++
  )
  const tree = (start: number, end: number): TabGroupLayoutNode =>
    end - start === 1
      ? {
          type: 'leaf',
          get groupId() {
            counts.groupLeaves++
            return `g${start}`
          }
        }
      : {
          type: 'split',
          direction: 'horizontal',
          ratio: 0.5,
          first: tree(start, Math.floor((start + end) / 2)),
          second: tree(Math.floor((start + end) / 2), end)
        }
  store.setState({
    tabsByWorktree: { [workspace]: tabs },
    unifiedTabsByWorktree: { [workspace]: items },
    worktreesByRepo: { repo: [makeWorktree({ id: workspace, repoId: 'repo' })] },
    layoutByWorktree: { [workspace]: tree(0, size) },
    terminalLayoutsByTabId: Object.fromEntries(
      tabs.map((tab) => [
        tab.id,
        {
          root: { type: 'leaf', leafId: leaf },
          activeLeafId: leaf,
          expandedLeafId: null,
          ptyIdsByLeafId: Object.fromEntries(tab.ptyId ? [[leaf, tab.ptyId]] : [])
        }
      ])
    ),
    ptyIdsByTabId: Object.fromEntries(tabs.map((tab) => [tab.id, [tab.ptyId ?? '']]))
  })
  Object.assign(counts, { groupLeaves: 0, rawRows: 0, unifiedRows: 0 })
  const signal = vi.spyOn(signals, 'tabAgentExitSignals'),
    scope = vi.spyOn(projections, 'terminalAgentEvidenceScopes'),
    route = vi.spyOn(routing, 'worktreeUsesRemoteConnection')
  const reset = () => {
    Object.assign(counts, { groupLeaves: 0, rawRows: 0, unifiedRows: 0 })
    signal.mockClear()
    scope.mockClear()
    route.mockClear()
  }
  const sample = () => ({
    ...counts,
    observations: signal.mock.calls.length / 2,
    scopes: scope.mock.calls.length,
    routes: route.mock.calls.length
  })
  return { store, status, counts, reset, sample, service: getTabAgentExitOwner(status) }
}

describe('root terminal evidence production operation budgets', () => {
  it.each([10, 100])(
    'shares grouped derivation and routes actual producers at %s terminals',
    (size) => {
      const { store, counts, reset, sample, service, status } = setup(size)
      const evidence: Record<string, ReturnType<typeof sample>> = {}
      stops.push(service.start())
      evidence.seed = sample()
      expect(counts.groupLeaves).toBe(size)
      expect(evidence.seed.observations).toBe(size)
      expect(evidence.seed.unifiedRows).toBeLessThanOrEqual(size * 2)
      reset()
      store.getState().updateTabTitle('tab-0', 'first renamed')
      evidence.single = sample()
      expect(evidence.single.observations).toBe(1)
      expect(counts.groupLeaves).toBe(0)
      reset()
      store
        .getState()
        .updateTabTitles(
          Array.from({ length: size }, (_, i) => ({ tabId: `tab-${i}`, title: `renamed ${i}` }))
        )
      evidence.batch = sample()
      expect(evidence.batch.observations).toBe(size)
      expect(counts.groupLeaves).toBe(0)
      expect(evidence.batch.unifiedRows).toBeLessThanOrEqual(size * 12)
      reset()
      store.getState().setPaneForegroundAgent(makePaneKey('tab-0', leaf), {
        agent: 'codex',
        shellForeground: false
      })
      evidence.process = sample()
      expect(evidence.process.observations).toBe(1)
      expect(counts.groupLeaves).toBe(0)
      reset()
      const state = store.getState()
      store.setState({
        worktreesByRepo: {
          repo: state.worktreesByRepo.repo.map((row) => ({ ...row, displayName: 'metadata only' }))
        },
        repos: state.repos.map((row) => ({ ...row, displayName: 'metadata only' })),
        unreadTerminalTabs: { 'tab-0': true }
      })
      evidence.metadata = sample()
      expect(evidence.metadata.observations).toBe(0)
      expect(evidence.metadata.routes).toBe(0)
      expect(evidence.metadata.rawRows).toBe(0)
      reset()
      store.setState({
        repos: [
          {
            id: 'repo',
            path: '/worktree',
            displayName: 'repo',
            badgeColor: '#000',
            addedAt: 0,
            connectionId: 'ssh-host'
          }
        ]
      })
      evidence.routing = sample()
      expect(evidence.routing.observations).toBe(size)
      expect(evidence.routing.routes).toBe(size * 2 + 2)
      expect(counts.groupLeaves).toBe(0)
      reset()
      // The getter/index sources remain warm when group helpers would return fresh synthetic leaves.
      store.setState({ layoutByWorktree: {}, activeGroupIdByWorktree: { [workspace]: 'g0' } })
      reset()
      store.getState().updateTabTitle('tab-0', 'synthetic renamed')
      expect(sample().observations).toBe(1)
      expect(counts.groupLeaves).toBe(0)
      expect(service.getObservation(workspace, 'tab-0', 'g0')).toBe(true)
      console.info('terminal-evidence-operation-counts', size, evidence)
      const transitions = vi.fn()
      const unsubscribe = status.subscribeTransitions(transitions)
      store.getState().updateTabTitle('tab-1', 'hinted title')
      expect(transitions.mock.calls.at(-1)?.[0].terminalFacts.tabsByWorktree).toEqual(['tab-1'])
      unsubscribe()
    }
  )
})
