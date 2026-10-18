import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SetCollapsedParams,
  type SetCollapsedRequest
} from '../../../src/shared/rpc-contract/workspace-view-collapse-params'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { INITIAL_MOBILE_VIEW } from '../worktree/workspace-view-settings'
import {
  PENDING_VIEW_CHANGE_STALE_MS,
  isSettledByDesktop,
  withPendingViewChanges
} from './host-view-pending-changes'
import {
  useHostPendingViewChanges,
  type HostPendingViewChanges
} from './use-host-pending-view-changes'

function ok(): RpcResponse {
  return {
    id: 'r',
    ok: true,
    result: { collapsed: true, applied: true },
    _meta: { runtimeId: 'x' }
  }
}

function refused(code: string): RpcResponse {
  return { id: 'r', ok: false, error: { code, message: code }, _meta: { runtimeId: 'x' } }
}

function mount(sendRequest: (method: string, params: unknown) => Promise<RpcResponse>) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook calls only sendRequest.
  const client = { sendRequest: vi.fn(sendRequest) } as unknown as RpcClient
  const notes: string[] = []
  const resync = vi.fn()
  let changes: HostPendingViewChanges | null = null
  function Probe(): null {
    changes = useHostPendingViewChanges({
      client,
      setActionError: (note) => notes.push(note),
      resync
    })
    return null
  }
  act(() => {
    create(createElement(Probe))
  })
  return { client, notes, resync, current: () => changes! }
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('the phone’s own option changes', () => {
  it('show as pending until the desktop acknowledges them', async () => {
    let answer: (reply: RpcResponse) => void = () => {}
    const screen = mount(() => new Promise((resolve) => (answer = resolve)))
    act(() => screen.current().sendView({ groupBy: 'none' }, { groupBy: 'none' }))
    expect(screen.current().pending).toHaveLength(1)
    answer(ok())
    await flush()
    expect(screen.current().pending).toEqual([])
    expect(screen.notes).toEqual([])
  })

  it('undo a refused change and say so', async () => {
    const screen = mount(async () => refused('invalid_params'))
    act(() => screen.current().sendView({ groupBy: 'none' }, { groupBy: 'none' }))
    await flush()
    expect(screen.current().pending).toEqual([])
    expect(screen.notes).toEqual(['The desktop did not take that change.'])
    expect(screen.resync).toHaveBeenCalledTimes(1)
  })

  it('keep a change the desktop has not answered, saying so after ten seconds', async () => {
    vi.useFakeTimers()
    const screen = mount(() => new Promise(() => {}))
    act(() => screen.current().sendView({ sortBy: 'name' }, { sortBy: 'name' }))
    expect(screen.current().stale).toBe(false)
    act(() => vi.advanceTimersByTime(PENDING_VIEW_CHANGE_STALE_MS))
    expect(screen.current().stale).toBe(true)
    expect(screen.current().pending).toHaveLength(1)
    expect(screen.notes).toEqual([])
  })

  it('keep a change whose request dropped, and resend it after a reconnect', async () => {
    const screen = mount(async () => {
      throw new Error('client_disconnected')
    })
    act(() => screen.current().sendView({ sortBy: 'name' }, { sortBy: 'name' }))
    await flush()
    expect(screen.current().pending).toHaveLength(1)
    let waiting: unknown[] = []
    act(() => {
      waiting = screen.current().reconcile({ sortBy: 'recent' }, { reconnected: true })
    })
    expect(waiting).toHaveLength(1)
    expect(screen.client.sendRequest).toHaveBeenCalledTimes(2)
    act(() => {
      waiting = screen.current().reconcile({ sortBy: 'name' }, { reconnected: false })
    })
    expect(waiting).toEqual([])
    expect(screen.current().pending).toEqual([])
  })

  it('collapse one section with ui.setCollapsed, falling back to the whole list without it', async () => {
    const methods: string[] = []
    const screen = mount(async (method) => {
      methods.push(method)
      return refused('method_not_found')
    })
    const wholeList = vi.fn()
    act(() => screen.current().sendCollapse('repo:orca', true, wholeList))
    await flush()
    expect(methods).toEqual(['ui.setCollapsed'])
    expect(wholeList).toHaveBeenCalledTimes(1)
    expect(screen.current().pending).toEqual([])
  })

  it('sends a collapse with a growing seq under one writer', async () => {
    const sent: SetCollapsedRequest[] = []
    const screen = mount(async (_method, params) => {
      sent.push(SetCollapsedParams.parse(params))
      return ok()
    })
    act(() => screen.current().sendCollapse('a', true, () => {}))
    act(() => screen.current().sendCollapse('a', false, () => {}))
    await flush()
    const [first, second] = sent
    expect(second.opId.writer).toBe(first.opId.writer)
    expect(second.opId.seq).toBeGreaterThan(first.opId.seq)
  })
})

describe('pending changes over the desktop’s values', () => {
  it('lay the desired values over the view, oldest first', () => {
    const view = withPendingViewChanges(INITIAL_MOBILE_VIEW, [
      { opId: 1, sentAt: 0, kind: 'view', patch: { groupBy: 'none' }, payload: {} },
      { opId: 2, sentAt: 0, kind: 'collapse', key: 'k', collapsed: true },
      { opId: 3, sentAt: 0, kind: 'view', patch: { groupBy: 'pr-status' }, payload: {} }
    ])
    expect(view.groupBy).toBe('pr-status')
    expect(view.collapsedGroups).toEqual(['k'])
  })

  it('settle once the desktop holds the asked value', () => {
    const collapse = { opId: 1, sentAt: 0, kind: 'collapse' as const, key: 'k', collapsed: true }
    expect(isSettledByDesktop(collapse, { collapsedGroups: ['k'] })).toBe(true)
    expect(isSettledByDesktop(collapse, { collapsedGroups: [] })).toBe(false)
    const filter = {
      opId: 2,
      sentAt: 0,
      kind: 'view' as const,
      patch: {},
      payload: { filterRepoIds: ['a'] }
    }
    expect(isSettledByDesktop(filter, { filterRepoIds: ['a'] })).toBe(true)
    expect(isSettledByDesktop(filter, { filterRepoIds: [] })).toBe(false)
  })
})
