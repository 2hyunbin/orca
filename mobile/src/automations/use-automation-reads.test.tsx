import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAutomationCatalog } from './use-automation-catalog'
import { useAutomationRuns, type AutomationRunScope } from './use-automation-runs'
import { automationClient, deferred, savedAutomation, savedRun } from './automation-test-fixtures'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'

vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) }
}))
let tree: ReactTestRenderer | null = null
afterEach(() => {
  act(() => tree?.unmount())
  tree = null
  vi.useRealTimers()
})
function latest<T>(read: () => T | null) {
  const value = read()
  if (!value) {
    throw new Error('Not mounted')
  }
  return value
}

describe('host-owned automation reads', () => {
  it('observes old loaded/selected identities through failures, reconnect and captured scopes', async () => {
    let runs = Array.from({ length: 65 }, (_, i) => ({
      ...savedRun(`r-${i}`),
      createdAt: 1000 - i,
      status: i === 64 ? 'dispatched' : 'completed'
    }))
    let fail = false
    const queries: unknown[] = []
    const port = automationClient((_method, params) => {
      queries.push(params)
      const request = params && typeof params === 'object' ? params : {}
      if (fail) {
        throw new Error('connection failed')
      }
      const cursor = 'cursor' in request ? request.cursor : undefined
      const start = cursor ? runs.findIndex((run) => run.id === cursor) + 1 : 0
      const page = runs.slice(start, start + 30)
      return { runs: page, nextCursor: start + 30 < runs.length ? page.at(-1)?.id : null }
    })
    let state: ReturnType<typeof useAutomationRuns> | null = null
    let query: AutomationRunScope = null
    let selected: ReturnType<typeof savedRun> | undefined
    function Probe({ revision, connected }: { revision: number; connected: boolean }) {
      state = useAutomationRuns(port.client, query, revision, connected, selected)
      return null
    }
    const read = () => latest(() => state)
    const update = async (revision: number, connected = true) => {
      await act(async () => {
        tree?.update(createElement(Probe, { revision, connected }))
      })
    }
    await act(async () => {
      tree = create(createElement(Probe, { revision: 0, connected: true }))
    })
    await act(async () => {
      read().loadMore()
    })
    await act(async () => {
      read().loadMore()
    })
    selected = read().runs.at(-1)
    expect(selected?.id).toBe('r-64')
    runs = [
      ...Array.from({ length: 40 }, (_, i) => ({
        ...savedRun(`new-${i}`),
        createdAt: 2000 - i,
        status: 'completed'
      })),
      ...runs.map((run) =>
        run.id === 'r-64'
          ? {
              ...run,
              status: 'completed',
              outputSnapshot: { content: 'Final saved output', capturedAt: 3000, truncated: false }
            }
          : run
      )
    ]
    fail = true
    await update(1)
    expect(read().selected?.status).toBe('dispatched')
    expect(read().error).toBeTruthy()
    await act(async () => {
      port.state('disconnected')
    })
    await update(1, false)
    fail = false
    await act(async () => {
      port.state('connected')
    })
    await update(2)
    expect(read().selected?.outputSnapshot?.content).toBe('Final saved output')
    expect(read().runs.find((run) => run.id === 'r-64')?.status).toBe('completed')
    expect(queries.every((params) => !JSON.stringify(params).includes('expectedOwner'))).toBe(true)
    runs = runs.map((run) =>
      run.id === 'r-64' ? { ...run, workspaceDisplayName: 'Renamed after completion' } : run
    )
    await update(3)
    expect(read().selected?.workspaceDisplayName).toBe('Renamed after completion')
    query = {
      automationId: 'automation-1',
      expectedOwner: { selector: { kind: 'ssh', targetId: 'captured', targetGeneration: 7 } }
    }
    queries.length = 0
    await update(4)
    expect(queries.length).toBeGreaterThan(3)
    expect(queries.every((params) => JSON.stringify(params).includes('captured'))).toBe(true)
    selected = undefined
    await update(5)
    expect(read().runs.at(-1)?.id).toBe('r-64')
  })
  it('ignores a previous connection snapshot and keeps delivery ambiguity until explicit refresh', async () => {
    const pending = deferred<unknown>()
    let listReads = 0
    const automation = savedAutomation()
    const catalogReply = {
      automations: [automation],
      items: [{ automationId: automation.id, selector: { kind: 'self' } }]
    }
    const port = automationClient((method) => {
      if (method === 'status.get') {
        return { capabilities: [] }
      }
      return ++listReads === 1 ? pending.promise : catalogReply
    })
    let state: ReturnType<typeof useAutomationCatalog> | null = null
    function Probe() {
      state = useAutomationCatalog(port.client, false)
      return null
    }
    const read = () => latest(() => state)
    await act(async () => {
      tree = create(createElement(Probe))
    })
    await act(async () => {
      port.state('disconnected')
      port.state('connected')
    })
    await act(async () => {
      pending.resolve({ automations: [], items: [] })
    })
    expect(read().rows.map((row) => row.automation.id)).toEqual(['automation-1'])
    let attempts = 0
    await act(async () => {
      await read().perform(
        async () => {
          attempts++
          throw markRpcDeliveryUnknown(new Error('Connection lost'))
        },
        () => {}
      )
    })
    expect(attempts).toBe(1)
    expect(read().error).toContain('may have applied')
    await act(async () => {
      port.event({ type: 'automationsChanged' })
    })
    expect(read().error).toContain('may have applied')
    await act(async () => {
      await read().refresh(true)
    })
    expect(read().error).toBeNull()
  })
  it('reports a superseded action as unknown and settles without accepting its reply', async () => {
    const port = automationClient((method) =>
      method === 'status.get' ? { capabilities: [] } : { automations: [], items: [] }
    )
    let state: ReturnType<typeof useAutomationCatalog> | null = null
    function Probe() {
      state = useAutomationCatalog(port.client, false)
      return null
    }
    await act(async () => {
      tree = create(createElement(Probe))
    })
    const read = () => latest(() => state)
    const accept = vi.fn()
    await act(async () => {
      await read().perform(async () => {
        port.state('connected')
        return savedRun('accepted-on-host')
      }, accept)
    })
    expect(accept).not.toHaveBeenCalled()
    expect(read().busy).toBe(false)
    expect(read().error).toContain('may have applied')
    expect(
      port.send.mock.calls.filter(([method]) => method === 'automation.list').length
    ).toBeGreaterThan(1)
  })
})
