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
  const workItems = await import('./mobile-work-items')
  const sourceErrors = await import('./github-work-item-source-errors')
  const { normalizeVisibleTaskProviders } = await import('./mobile-task-providers')
  return {
    useCallback: react.useCallback,
    useEffect: react.useEffect,
    useMemo: react.useMemo,
    useRef: react.useRef,
    useState: react.useState,
    useHostRepoList,
    normalizeVisibleTaskProviders,
    isHostedTaskRepo: (await import('./hosted-repo-selection')).isHostedTaskRepo,
    CROSS_REPO_DISPLAY_LIMIT: workItems.CROSS_REPO_DISPLAY_LIMIT,
    PER_REPO_FETCH_LIMIT: workItems.PER_REPO_FETCH_LIMIT,
    isGitHubWorkItemsSshRemoteRequiredError: workItems.isGitHubWorkItemsSshRemoteRequiredError,
    extractGitHubIssueSourceError: sourceErrors.extractGitHubIssueSourceError,
    extractGitHubIssueSourceFallback: sourceErrors.extractGitHubIssueSourceFallback,
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
  reconcileTeamSelection: () => new Set(),
  DEFAULT_LINEAR_DISPLAY_PROPERTIES: [],
  GITHUB_REPO_CONCURRENCY: 3,
  GITLAB_PER_PAGE: 50,
  LINEAR_LIMIT: 50,
  buildPartialRepositoryNotice: () => 'Some repositories failed to load.',
  groupDetailComments: () => []
}))

const { useMobileTasksRouteAndItemState } = await import('./use-mobile-tasks-route-and-item-state')
const { useMobileTasksProviderLoadActions } =
  await import('./use-mobile-tasks-provider-load-actions')
const { useMobileTasksTaskListLoading } = await import('./use-mobile-tasks-task-list-loading')
const { useTaskRepoSelectionReconcile } = await import('./use-task-repo-selection-reconcile')

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

function issue(title: string) {
  return {
    id: title,
    type: 'issue',
    number: 1,
    title,
    state: 'open',
    url: 'https://github.com/o/r/issues/1',
    labels: [],
    updatedAt: '2026-10-11T00:00:00Z',
    author: null
  }
}

/** A desktop relaying to `runtime:vm`, whose repo list `vmRepoList` answers. */
function desktop(
  vmRepoList: () => Promise<unknown> = async () => ({ repos: VM_REPOS })
): FakeSession {
  return recording(new FakeSession('connected'), async (method, executionHost) => {
    if (method === 'mobileRelay.hosts.list') {
      return reply({ hosts: HOSTS })
    }
    if (method === 'github.listWorkItems') {
      return reply({ items: [issue(executionHost ? 'from the server' : 'from the desktop')] })
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

type Model = ReturnType<typeof useMobileTasksTaskListLoading>
/** What each render showed: the full-list spinner, and how many items. */
const renders: { loading: boolean; count: number }[] = []
const mounted: ReactTestRenderer[] = []
afterEach(() => {
  for (const renderer of mounted.splice(0)) {
    act(() => renderer.unmount())
  }
})

async function mount(
  client: FakeSession,
  hostCapabilities: string[],
  savedSelection: string[] = []
): Promise<() => Model> {
  desktopRef.current = client
  const seen: { model?: Model } = {}
  function Harness(): null {
    const route = useMobileTasksRouteAndItemState()
    if (route.defaultRepoSelectionRef.current === null) {
      route.defaultRepoSelectionRef.current = savedSelection
    }
    useTaskRepoSelectionReconcile(route)
    // Stage 6 binds this to the live client; a load only commits for the client it started on.
    route.clientRef.current = route.client
    // The list's loaders, fed the screen's own model as the screen feeds them. Stages 2-6 are
    // stood in for by the three members they would add: hydrated, supported, and the page reset.
    seen.model = useMobileTasksTaskListLoading(
      useMobileTasksProviderLoadActions(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the loaders read only stage-1 members and the three stood-in ones.
        {
          ...route,
          taskStateHydrated: true,
          tasksSupported: true,
          resetGitHubItemsState: () => {}
        } as unknown as Parameters<typeof useMobileTasksProviderLoadActions>[0]
      )
    )
    renders.push({ loading: seen.model.loading, count: seen.model.items.length })
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
// A server's SSH-backed repo keeps its connection, which that server holds.
const VM_SSH_REPO = { ...VM_REPOS[1], executionHostId: 'runtime:vm' }

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
    expect(model().repos).toEqual([...MAC_REPOS, VM_REPO, VM_SSH_REPO])
    expect(await loadRepos(model)).toEqual([...MAC_REPOS, VM_REPO, VM_SSH_REPO])
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

  it("loads a server repo's GitHub items from that server, as the screen's list does", async () => {
    const client = desktop()
    const model = await mount(client, [MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY])
    await loadRepos(model)
    await settle()
    // Only this page's calls: the screen's own quiet reload already ran when the server joined.
    const earlier = ranOn(client, 'github.listWorkItems').length
    const page: { titles?: string[] } = {}
    await act(async () => {
      const loaded = await model().fetchGitHubItemsPage(model().client!, model().repos)
      page.titles = loaded.items.map((item) => item.title).sort()
    })
    expect(page.titles).toEqual(['from the desktop', 'from the server', 'from the server'])
    expect(ranOn(client, 'github.listWorkItems').slice(earlier).sort()).toEqual([
      'desktop',
      'runtime:vm',
      'runtime:vm'
    ])
  })

  it("names a server repo's host before its path in the repo pickers", async () => {
    const model = await mount(desktop(), [MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY])
    await loadRepos(model)
    await settle()
    const details = model().repos.map((repo) => getTaskRepoDetail(repo, model().repoHostLabels))
    expect(details).toEqual(['This computer · /mac/app', 'VM · /srv/api', 'VM · /r'])
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

  it("keeps a saved selection of a server's repo while that server answers late", async () => {
    const late = deferred<unknown>()
    const model = await mount(
      desktop(() => late.promise),
      [MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY],
      ['vm-repo']
    )
    await loadRepos(model)
    await settle()
    // Not yet applied: the server hasn't answered, so `vm-repo` is pending rather than gone.
    expect([...model().selectedRepoIds]).toEqual([])
    late.resolve({ repos: VM_REPOS })
    await settle()
    expect([...model().selectedRepoIds]).toEqual(['vm-repo'])
  })

  it("adds a late server's items without blanking the desktop's or showing the full spinner", async () => {
    const late = deferred<unknown>()
    const model = await mount(
      desktop(() => late.promise),
      [MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY]
    )
    await act(async () => {
      await model().loadTasks()
    })
    expect({ error: model().error, titles: model().items.map((item) => item.title) }).toEqual({
      error: '',
      titles: ['from the desktop']
    })
    const joinedFrom = renders.length
    late.resolve({ repos: VM_REPOS })
    await settle()
    expect(
      model()
        .items.map((item) => item.title)
        .sort()
    ).toEqual(['from the desktop', 'from the server', 'from the server'])
    expect(renders.slice(joinedFrom).filter((seen) => seen.loading || seen.count === 0)).toEqual([])
  })
})

function deferred<Value>() {
  let resolve: (value: Value) => void = () => {}
  const promise = new Promise<Value>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}
