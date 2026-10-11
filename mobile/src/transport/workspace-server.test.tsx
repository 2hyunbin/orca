import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({ AppState: { currentState: 'active' } }))
// The server status gates beside this hook persist what a desktop reports; nothing here reads them.
vi.mock('./host-app-version-store', () => ({ recordHostAppVersion: async () => {} }))
vi.mock('./host-descriptor-recorder', () => ({ recordHostDescriptorFromStatus: () => {} }))

import type { ExecutionHostId } from '../../../src/shared/execution-host'
import { MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY } from '../../../src/shared/mobile-desktop-relay-contract'
import { MOBILE_RELAY_HOSTS_LIST_METHOD } from '../../../src/shared/mobile-relay-hosts-contract'
import { FakeSession } from './mobile-endpoint-supervisor-test-fakes'
import type { RpcClient } from './rpc-client'
import { useReachableServerClients } from './workspace-server'

const RELAYS = [MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY]

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
  it('are offered when the sheet opens, whether or not the host list has loaded their rows', async () => {
    const client = desktop()
    const seen: { clients: ReadonlyMap<ExecutionHostId, RpcClient> | null } = { clients: null }
    function Sheet({ open }: { open: boolean }): null {
      seen.clients = useReachableServerClients(open ? client : null, RELAYS)
      return null
    }
    const rendered: { tree: ReturnType<typeof create> | null } = { tree: null }
    await act(async () => {
      rendered.tree = create(createElement(Sheet, { open: false }))
    })
    // Closed, it asks nothing of the desktop.
    expect(listCalls(client)).toBe(0)
    expect([...(seen.clients?.keys() ?? [])]).toEqual([])
    await act(async () => {
      rendered.tree?.update(createElement(Sheet, { open: true }))
    })
    expect([...(seen.clients?.keys() ?? [])]).toEqual(['runtime:vm'])
  })
})
