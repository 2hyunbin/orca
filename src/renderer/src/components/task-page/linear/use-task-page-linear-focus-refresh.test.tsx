// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import { createTestStore, deferred, issue } from '@/store/slices/linear-slice-test-harness'
import { CACHE_TTL } from '@/store/slices/linear/linear-cache'
import { useTaskPageLinearInOrcaEffects } from './use-task-page-linear-in-orca-effects'
import { useTaskPageLinearListEffects } from './use-task-page-linear-list-effects'

const provider = vi.hoisted(() => ({ get: vi.fn(), list: vi.fn(), search: vi.fn() }))
vi.mock('@/runtime/runtime-linear-issue-mutations', () => ({ linearGetIssue: provider.get }))
vi.mock('@/runtime/runtime-linear-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  linearListIssues: provider.list,
  linearSearchIssues: provider.search
}))
vi.mock('@/hooks/useIssueMetadata', () => ({ clearLinearMetadataCache: vi.fn() }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('../../linear-issue-view-storage', () => ({ saveLinearIssueView: vi.fn() }))

const source: TaskSourceContext = {
  kind: 'task-source',
  provider: 'linear',
  projectId: 'project',
  hostId: 'runtime:server',
  providerIdentity: { provider: 'linear', workspaceId: 'workspace' }
}
let now = 1_000_000
let status = 'In Review'
function currentIssue(id: string): LinearIssue {
  return {
    ...issue(id),
    workspaceId: 'workspace',
    state: { name: status, type: 'started', color: '#888888' }
  }
}
function returnToWindow() {
  window.dispatchEvent(new Event('blur'))
  window.dispatchEvent(new Event('focus'))
}

function setup(mode: 'in-orca' | 'issues', count = 1, search = '', store = createTestStore()) {
  store.setState({
    linearStatus: { connected: true, selectedWorkspaceId: 'workspace', viewer: null }
  })
  const actions = store.getState()
  const refs = Array.from({ length: count }, (_, i) => ({
    identifier: `DAT-${i}`,
    workspaceId: 'workspace',
    sourceContext: source
  }))
  const hook = renderHook(
    ({ nonce }) => {
      const [rows, setLinearIssues] = useState<LinearIssue[]>([])
      const [loading, setLinearLoading] = useState(false)
      const [error, setLinearError] = useState<string | null>(null)
      const lastLinearRequestRef = useRef<{ signature: string; nonce: number } | null>(null)
      const inOrcaLinkedLinearRefsRef = useRef(refs)
      const landingLinearRefreshKeysRef = useRef(new Set<string>())
      const linearAttributeFilterReadRef = useRef(null)
      const linearSearchPersistReadyRef = useRef(false)
      const linearViewPersistReadyRef = useRef(false)
      const model = {
        ...actions,
        taskSource: 'linear',
        linearMode: mode,
        taskResumeApplied: true,
        linearConnected: true,
        selectedLinearWorkspaceId: 'workspace',
        linearTaskSourceContext: source,
        setLinearIssues,
        setLinearLoading,
        setLinearError,
        setLinearIssuesHasMore: noop,
        linearRefreshNonce: nonce,
        lastLinearRequestRef,
        inOrcaLinkedLinearRefsRef,
        inOrcaLinkedLinearRefsSignature: refs.map((ref) => ref.identifier).join('|'),
        landingLinearRefreshKeysRef,
        linearAttributeFilterReadRef,
        linearSearchPersistReadyRef,
        linearViewPersistReadyRef,
        appliedLinearSearch: search,
        linearSearchInput: search,
        linearIssueLimit: 50,
        linearAttributeFilterWorkspaceId: 'workspace',
        linearAttributeFilter: undefined,
        linearIssueFiltersByWorkspaceId: {},
        linearDisplayProperties: new Set(),
        setTaskResumeState: noop,
        setAppliedLinearSearch: noop,
        setLinearIssueLimit: noop,
        setLinearIssuePage: noop,
        setLinearIssueLoadingTargetPage: noop
      }
      // SAFETY: this fixture supplies every property read by these two composition hooks; unrelated page fields are unused.
      const pageModel = model as unknown as Parameters<typeof useTaskPageLinearListEffects>[0]
      useTaskPageLinearListEffects(pageModel)
      useTaskPageLinearInOrcaEffects(pageModel)
      return { rows, loading, error }
    },
    { initialProps: { nonce: 0 } }
  )
  return { ...hook, store }
}
function noop() {}

beforeEach(() => {
  now = 1_000_000
  status = 'In Review'
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  provider.get.mockReset().mockImplementation(async (_scope, id: string) => currentIssue(id))
  provider.list.mockReset().mockImplementation(async () => ({ items: [currentIssue('DAT-0')] }))
  provider.search.mockReset().mockImplementation(async () => [currentIssue('DAT-0')])
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Tasks Linear focus revalidation', () => {
  it.each(['in-orca', 'issues'] as const)(
    'updates mounted %s rows after an external status change on focus',
    async (mode) => {
      const view = setup(mode)
      await act(async () => {})
      expect(view.result.current.rows[0]?.state.name).toBe('In Review')
      status = 'Done'
      now += CACHE_TTL + 1
      await act(async () => returnToWindow())
      expect(view.result.current.rows[0]?.state.name).toBe('Done')
      expect(provider.get.mock.calls.length + provider.list.mock.calls.length).toBe(2)
    }
  )

  it('still refreshes explicitly within the TTL and reads stale data on landing', async () => {
    const view = setup('in-orca')
    await act(async () => {})
    status = 'Done'
    await act(async () => view.rerender({ nonce: 1 }))
    expect(view.result.current.rows[0]?.state.name).toBe('Done')
    expect(provider.get).toHaveBeenCalledTimes(2)
    view.unmount()
    status = 'Canceled'
    now += CACHE_TTL + 1
    const landing = setup('in-orca', 1, '', view.store)
    await act(async () => {})
    expect(landing.result.current.rows[0]?.state.name).toBe('Canceled')
  })
  it.each([6, 60])(
    'bounds a focus burst at %i linked issues to one read each with six in flight',
    async (count) => {
      const view = setup('in-orca', count)
      await act(async () => {})
      expect(provider.get).toHaveBeenCalledTimes(count)
      status = 'Done'
      now += CACHE_TTL + 1
      const gate = deferred<void>()
      let active = 0
      let peak = 0
      provider.get.mockImplementation(async (_scope, id: string) => {
        active++
        peak = Math.max(peak, active)
        await gate.promise
        active--
        return currentIssue(id)
      })
      await act(async () => returnToWindow())
      expect(provider.get).toHaveBeenCalledTimes(count + 6)
      expect(view.result.current.loading).toBe(false)
      expect(view.result.current.rows).toHaveLength(count)
      expect(view.result.current.rows[0]?.state.name).toBe('In Review')
      await act(async () => {
        for (let i = 0; i < 10; i++) {
          returnToWindow()
          document.dispatchEvent(new Event('visibilitychange'))
        }
      })
      expect(provider.get).toHaveBeenCalledTimes(count + 6)
      await act(async () => gate.resolve())
      expect(provider.get).toHaveBeenCalledTimes(2 * count)
      expect(peak).toBe(6)
      expect(view.result.current.rows.every((row) => row.state.name === 'Done')).toBe(true)
      expect(provider.get).toHaveBeenLastCalledWith(source, `DAT-${count - 1}`, 'workspace')
      await act(async () => returnToWindow())
      expect(provider.get).toHaveBeenCalledTimes(2 * count)
      view.unmount()
      now += CACHE_TTL + 1
      await act(async () => returnToWindow())
      expect(provider.get).toHaveBeenCalledTimes(2 * count)
    }
  )

  it.each(['', 'query'])(
    'keeps list/search rows visible, skips fresh focus and coalesces stale focus reads (%s)',
    async (search) => {
      const view = setup('issues', 1, search)
      const read = search ? provider.search : provider.list
      await act(async () => {})
      await act(async () => returnToWindow())
      expect(read).toHaveBeenCalledTimes(1)
      now += CACHE_TTL + 1
      status = 'Done'
      const gate = deferred<void>()
      read.mockImplementation(async () => {
        await gate.promise
        return search ? [currentIssue('DAT-0')] : { items: [currentIssue('DAT-0')] }
      })
      await act(async () => returnToWindow())
      expect(view.result.current.loading).toBe(false)
      expect(view.result.current.rows[0]?.state.name).toBe('In Review')
      await act(async () => {
        returnToWindow()
        document.dispatchEvent(new Event('visibilitychange'))
      })
      expect(read).toHaveBeenCalledTimes(2)
      await act(async () => gate.resolve())
      expect(view.result.current.rows[0]?.state.name).toBe('Done')
    }
  )

  it('revalidates when a hidden window becomes visible and ignores focus while hidden', async () => {
    const view = setup('in-orca')
    await act(async () => {})
    now += CACHE_TTL + 1
    status = 'Done'
    const visibility = vi.spyOn(document, 'visibilityState', 'get')
    visibility.mockReturnValue('hidden')
    await act(async () => returnToWindow())
    expect(provider.get).toHaveBeenCalledTimes(1)
    visibility.mockReturnValue('visible')
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(view.result.current.rows[0]?.state.name).toBe('Done')
    expect(provider.get).toHaveBeenCalledTimes(2)
  })
  it('joins an existing scoped issue read rather than starting another on focus', async () => {
    const view = setup('in-orca')
    await act(async () => {})
    now += CACHE_TTL + 1
    status = 'Done'
    const gate = deferred<LinearIssue>()
    provider.get.mockReturnValueOnce(gate.promise)
    const detailRead = view.store
      .getState()
      .fetchLinearIssue('DAT-0', 'workspace', { sourceContext: source })
    await act(async () => returnToWindow())
    expect(provider.get).toHaveBeenCalledTimes(2)
    await act(async () => {
      gate.resolve(currentIssue('DAT-0'))
      await detailRead
    })
    expect(view.result.current.rows[0]?.state.name).toBe('Done')
    expect(provider.get).toHaveBeenCalledTimes(2)
  })
})
