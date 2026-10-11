import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({ AppState: { currentState: 'active' } }))
vi.mock('../transport/host-descriptor-store', () => ({ useHostDescriptor: () => null }))

import type { ExecutionHostId } from '../../../src/shared/execution-host'
import { MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY } from '../../../src/shared/mobile-desktop-relay-contract'
import { MOBILE_RELAY_HOSTS_LIST_METHOD } from '../../../src/shared/mobile-relay-hosts-contract'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import { useNewWorkspaceServers } from './use-host-display-worktrees'

const RELAYS = [MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY]
// The host list's own labels: what a sheet opened from Home sees before the list loads a server.
const DESKTOP_LABELS: ReadonlyMap<ExecutionHostId, string> = new Map()

/** A desktop that lists one ready server. */
function desktop(): FakeSession {
  const session = new FakeSession('connected')
  session.sendRequest.mockImplementation(async (method: string) => ({
    id: 'reply',
    ok: true,
    result:
      method === MOBILE_RELAY_HOSTS_LIST_METHOD
        ? { hosts: [{ hostId: 'runtime:vm', label: 'vm', health: 'available', relay: 'ready' }] }
        : {},
    _meta: { runtimeId: 'runtime-1' }
  }))
  return session
}

function listCalls(session: FakeSession): number {
  return session.sendRequest.mock.calls.filter(
    ([method]) => method === MOBILE_RELAY_HOSTS_LIST_METHOD
  ).length
}

describe('the servers a new workspace can run on', () => {
  it('are offered, by name, when the sheet opens before the host list has loaded them', async () => {
    const client = desktop()
    const seen: { value: ReturnType<typeof useNewWorkspaceServers> | null } = { value: null }
    function Sheet({ open }: { open: boolean }): null {
      seen.value = useNewWorkspaceServers({
        client,
        hostCapabilities: RELAYS,
        hostLabelById: DESKTOP_LABELS,
        open
      })
      return null
    }
    const rendered: { tree: ReturnType<typeof create> | null } = { tree: null }
    await act(async () => {
      rendered.tree = create(createElement(Sheet, { open: false }))
    })
    // Closed, it asks nothing of the desktop.
    expect(listCalls(client)).toBe(0)
    expect([...(seen.value?.serverClients.keys() ?? [])]).toEqual([])
    await act(async () => {
      rendered.tree?.update(createElement(Sheet, { open: true }))
    })
    expect([...(seen.value?.serverClients.keys() ?? [])]).toEqual(['runtime:vm'])
    expect(seen.value?.hostLabelById.get('runtime:vm')).toBe('vm')
  })
})
