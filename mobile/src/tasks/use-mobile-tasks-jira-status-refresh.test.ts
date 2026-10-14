import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import {
  type ProviderLoadActionsInput,
  useMobileTasksProviderLoadActions
} from './use-mobile-tasks-provider-load-actions'

vi.mock('./mobile-tasks-dependencies', async () => {
  const { useCallback } = await import('react')
  return { useCallback }
})
vi.mock('./mobile-tasks-legacy-foundation', () => ({}))

const mounted: ReactTestRenderer[] = []
afterEach(() => {
  act(() => {
    for (const renderer of mounted.splice(0)) {
      renderer.unmount()
    }
  })
})

function mountRefresh(client: RpcClient, clientRef: { current: RpcClient | null }) {
  const setJiraConnection = vi.fn()
  const holder: { refresh?: () => Promise<void> } = {}
  function Probe() {
    const input: ProviderLoadActionsInput = {
      appliedQuery: '',
      client,
      clientRef,
      connState: 'connected',
      defaultLinearTeamSelectionRef: { current: null },
      githubKind: 'issues',
      setJiraConnection,
      setLinearConnected: vi.fn(),
      setLinearTeams: vi.fn(),
      setLinearWorkspaces: vi.fn(),
      setSelectedLinearTeamIds: vi.fn(),
      setSelectedLinearWorkspaceId: vi.fn(),
      taskUiReady: true,
      tasksSupported: true
    }
    holder.refresh = useMobileTasksProviderLoadActions(input).refreshJiraConnection
    return null
  }
  act(() => {
    mounted.push(create(createElement(Probe)))
  })
  return {
    setJiraConnection,
    refresh: async () => {
      if (!holder.refresh) {
        throw new Error('Jira refresh did not render')
      }
      await holder.refresh()
    }
  }
}

function pendingStatus() {
  let answer: (reply: RpcResponse) => void = () => {
    throw new Error('Status promise is not ready')
  }
  const response = new Promise<RpcResponse>((resolve) => {
    answer = resolve
  })
  return { response, answer }
}

describe('mobile Jira status host ownership', () => {
  it('applies an explicit status refresh for the current host', async () => {
    const client = new FakeSession('connected')
    client.sendRequest.mockResolvedValue({
      id: 'jira-test',
      ok: true,
      result: { connected: false }
    })
    const fixture = mountRefresh(client, { current: client })
    await fixture.refresh()
    expect(client.sendRequest).toHaveBeenCalledWith('jira.status')
    expect(fixture.setJiraConnection).toHaveBeenCalledTimes(1)
  })

  it('ignores a previous host status that arrives after switching hosts', async () => {
    const client = new FakeSession('connected')
    const nextClient = new FakeSession('connected')
    const status = pendingStatus()
    client.sendRequest.mockReturnValue(status.response)
    const clientRef = { current: client }
    const fixture = mountRefresh(client, clientRef)
    const refresh = fixture.refresh()
    clientRef.current = nextClient
    status.answer({ id: 'jira-test', ok: true, result: { connected: false } })
    await refresh
    expect(fixture.setJiraConnection).not.toHaveBeenCalled()
  })
})
