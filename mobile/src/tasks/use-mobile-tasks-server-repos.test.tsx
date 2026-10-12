import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY } from '../../../src/shared/mobile-desktop-relay-contract'
import { HostStatusGatesContext } from '../components/host-protocol-gates-context'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import type { HostStatusGates } from '../transport/host-status-gates'
import type { RpcResponse } from '../transport/types'
import { getTaskRepoDetail } from './mobile-tasks-repository-presentation'

const desktopRef: { current: FakeSession | null } = { current: null }

vi.mock('react-native', () => ({ AppState: { currentState: 'active' } }))
vi.mock('./mobile-tasks-dependencies', async () => {
  const react = await import('react')
  const { useHostRepoList } = await import('./use-host-repo-list')
  const { normalizeVisibleTaskProviders } = await import('./mobile-task-providers')
  return {
    useCallback: react.useCallback,
    useMemo: react.useMemo,
    useRef: react.useRef,
    useState: react.useState,
    useHostRepoList,
    normalizeVisibleTaskProviders,
    useHostClient: () => ({ client: desktopRef.current, state: 'connected' }),
    useLocalSearchParams: () => ({ hostId: 'mac' }),
    useRouter: () => ({}),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    useReconnectAttempt: () => 0,
    useLastConnectedAt: () => null,
    useRelayRecoveryStatus: () => null
  }
})
vi.mock('./mobile-tasks-legacy-foundation', async () => ({
  ...(await import('./mobile-tasks-item-mapping')),
  DEFAULT_LINEAR_DISPLAY_PROPERTIES: [],
  groupDetailComments: () => []
}))

const { useMobileTasksRouteAndItemState } = await import('./use-mobile-tasks-route-and-item-state')

type Sent = { method: string; executionHost?: string }
const sentBy = new WeakMap<FakeSession, Sent[]>()

/** Records where each call ran, then answers it with `answer`. */
function recording(
  client: FakeSession,
  answer: (method: string, executionHost: string | undefined) => Promise<RpcResponse>
): FakeSession {
  const sent: Sent[] = []
  sentBy.set(client, sent)
  client.sendRequest.mockImplementation(
    async (method: string, _params?: unknown, options?: { executionHost?: string }) => {
      sent.push({ method, executionHost: options?.executionHost })
      return answer(method, options?.executionHost)
    }
  )
  return client
}

function reply(result: unknown): RpcResponse {
  return { id: 'reply', ok: true, result, _meta: { runtimeId: 'runtime' } }
}

const MAC_REPOS = [{ id: 'mac-repo', displayName: 'app', path: '/mac/app' }]
const VM_REPOS = [
  { id: 'vm-repo', displayName: 'api', path: '/srv/api' },
  { id: 'vm-ssh-repo', displayName: 'remote', path: '/r', connectionId: 'vm-ssh' }
]
const HOSTS = [
  { hostId: 'runtime:vm', label: 'VM', health: 'available', relay: 'ready' },
  { hostId: 'runtime:old', label: 'ThinkPad', health: 'available', relay: 'update-needed' }
]

/** A desktop relaying to `runtime:vm`, whose repo list `vmRepoList` answers. */
function desktop(
  vmRepoList: () => Promise<unknown> = async () => ({ repos: VM_REPOS })
): FakeSession {
  return recording(new FakeSession('connected'), async (method, executionHost) => {
    if (method === 'mobileRelay.hosts.list') {
      return reply({ hosts: HOSTS })
    }
    if (method !== 'repo.list') {
      return reply({})
    }
    if (executionHost !== 'runtime:vm') {
      return reply({ repos: executionHost ? [] : MAC_REPOS })
    }
    return reply(await vmRepoList())
  })
}

type Model = ReturnType<typeof useMobileTasksRouteAndItemState>
const mounted: ReactTestRenderer[] = []
afterEach(() => {
  for (const renderer of mounted.splice(0)) {
    act(() => renderer.unmount())
  }
})

async function mount(client: FakeSession, hostCapabilities: string[]): Promise<() => Model> {
  desktopRef.current = client
  const seen: { model?: Model } = {}
  function Harness(): null {
    seen.model = useMobileTasksRouteAndItemState()
    return null
  }
  const gates: HostStatusGates = {
    hostCapabilities,
    floatingWorkspaceEnabled: false,
    desktopAppVersion: null,
    compatVerdict: { kind: 'ok' },
    hostProtocolWindow: { protocolVersion: undefined, minCompatibleMobileVersion: undefined },
    statusPending: false,
    statusReadable: true
  }
  await act(async () => {
    mounted.push(
      create(
        createElement(HostStatusGatesContext.Provider, { value: gates }, createElement(Harness))
      )
    )
  })
  return () => seen.model!
}

async function loadRepos(model: () => Model): Promise<unknown> {
  const loaded: { repos?: unknown } = {}
  await act(async () => {
    loaded.repos = await model().repoListEnsureLoaded()
  })
  return loaded.repos
}

/** Lets the hosts feed and every answered server list land. */
async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

const VM_REPO = {
  id: 'vm-repo',
  displayName: 'api',
  path: '/srv/api',
  executionHostId: 'runtime:vm'
}

/** Where each call on the screen's client ran: its `executionHost`, or `desktop`. */
function ranOn(client: FakeSession, method: string): string[] {
  return (sentBy.get(client) ?? [])
    .filter((sent) => sent.method === method)
    .map((sent) => sent.executionHost ?? 'desktop')
}

describe('Tasks screen repos on the desktop and its servers', () => {
  it("lists a reachable server's repos beside the desktop's, as the desktop's task page does", async () => {
    const client = desktop()
    const model = await mount(client, [MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY])
    await loadRepos(model)
    await settle()
    expect(model().repos).toEqual([...MAC_REPOS, VM_REPO])
    expect(await loadRepos(model)).toEqual([...MAC_REPOS, VM_REPO])
    // The server needing an update is never asked.
    expect(ranOn(client, 'repo.list').sort()).toEqual(['desktop', 'runtime:vm'])
  })

  it('loads the desktop list while a server never answers', async () => {
    const client = desktop(() => new Promise(() => {}))
    const model = await mount(client, [MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY])
    expect(await loadRepos(model)).toEqual(MAC_REPOS)
    await settle()
    expect(ranOn(client, 'repo.list').sort()).toEqual(['desktop', 'runtime:vm'])
    expect(model().repos).toEqual(MAC_REPOS)
  })

  it("runs a server repo's work-item calls on that server and the rest on the desktop", async () => {
    const client = desktop()
    const model = await mount(client, [MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY])
    await settle()
    await loadRepos(model)
    const screenClient = model().client!
    await screenClient.sendRequest('github.listWorkItems', { repo: 'id:vm-repo', limit: 1 })
    await screenClient.sendRequest('gitlab.workItemDetails', { repo: 'id:vm-repo', iid: 1 })
    await screenClient.sendRequest('github.listWorkItems', { repo: 'id:mac-repo', limit: 1 })
    await screenClient.sendRequest('linear.status', undefined)
    expect(ranOn(client, 'github.listWorkItems')).toEqual(['runtime:vm', 'desktop'])
    expect(ranOn(client, 'gitlab.workItemDetails')).toEqual(['runtime:vm'])
    expect(ranOn(client, 'linear.status')).toEqual(['desktop'])
  })

  it("names a server repo's host before its path in the repo pickers", async () => {
    const model = await mount(desktop(), [MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY])
    await loadRepos(model)
    await settle()
    const details = model().repos.map((repo) => getTaskRepoDetail(repo, model().serverLabelById))
    expect(details).toEqual(['/mac/app', 'VM · /srv/api'])
  })

  it('keeps the desktop list alone on a desktop that does not relay', async () => {
    const client = desktop()
    const model = await mount(client, [])
    await settle()
    expect(await loadRepos(model)).toEqual(MAC_REPOS)
    expect(ranOn(client, 'mobileRelay.hosts.list')).toEqual([])
    expect(ranOn(client, 'repo.list')).toEqual(['desktop'])
  })

  it("keeps the desktop's repos when a server fails to list its own", async () => {
    const model = await mount(
      desktop(async () => {
        throw new Error('server went away')
      }),
      [MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY]
    )
    await settle()
    expect(await loadRepos(model)).toEqual(MAC_REPOS)
    expect(model().repos).toEqual(MAC_REPOS)
  })
})
