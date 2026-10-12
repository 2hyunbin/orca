import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'

const asyncStorage = vi.hoisted(() => ({
  getItem: vi.fn().mockResolvedValue(null),
  setItem: vi.fn().mockResolvedValue(undefined),
  removeItem: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }))
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  AppState: { currentState: 'active' },
  FlatList: 'FlatList',
  Image: 'Image',
  Keyboard: { dismiss: vi.fn() },
  Linking: { openURL: vi.fn() },
  Modal: 'Modal',
  ScrollView: 'ScrollView',
  Platform: { OS: 'ios', select: (options: { ios?: unknown }) => options.ios },
  Pressable: 'Pressable',
  StyleSheet: { create: <T,>(styles: T) => styles },
  Switch: 'Switch',
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View'
}))
// Every icon in the drawer tree renders as a host element named after itself.
vi.mock(
  'lucide-react-native',
  () =>
    new Proxy(
      {},
      {
        get: (_target, name) => (typeof name === 'string' ? name : undefined),
        has: () => true
      }
    )
)
vi.mock('./BottomDrawer', () => ({ BottomDrawer: 'BottomDrawer' }))
vi.mock('./bottom-drawer-modal-host', () => ({ BottomDrawerModalHost: 'BottomDrawerModalHost' }))
vi.mock('./PickerListDrawer', () => ({ PickerListDrawer: 'PickerListDrawer' }))
vi.mock('./MobileAgentIcon', () => ({ MobileAgentIcon: 'MobileAgentIcon' }))
vi.mock('./TaskProviderLogo', () => ({ TaskProviderLogo: 'TaskProviderLogo' }))

import { recordHostDescriptor } from '../transport/host-descriptor-store'
import {
  getLocalExecutionHostLabel,
  type ExecutionHostId
} from '../../../src/shared/execution-host'
import { NewWorktreeModal } from './NewWorktreeModal'

const LOCAL_HOST_LABEL = getLocalExecutionHostLabel('darwin')

const repos = [
  {
    id: 'repo-1',
    displayName: 'orca',
    path: '/src/orca',
    kind: 'git',
    upstream: { owner: 'stablyai', repo: 'orca' }
  }
]

function pickerItems(
  renderer: ReactTestRenderer,
  title: string
): { label: string; detail: string }[] {
  const pickers = renderer.root.findAll((node) => isHost(node.type, 'PickerListDrawer'))
  const picker = pickers.find((node) => node.props.title === title)
  return picker?.props.items ?? []
}

function sourceInputs(renderer: ReactTestRenderer) {
  return renderer.root.findAll(
    (node) =>
      isHost(node.type, 'TextInput') && node.props.placeholder === 'Type a name or search a source'
  )
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the modal only sends requests.
const requestsOnly = (sendRequest: unknown) => ({ sendRequest }) as unknown as RpcClient

function runTargetPicker(renderer: ReactTestRenderer) {
  return renderer.root
    .findAll((node) => isHost(node.type, 'PickerListDrawer'))
    .find((node) => node.props.title === 'Run on')!
}

/** Every element the mocks render is a host string, which `ElementType` does not admit as a literal. */
function isHost(type: unknown, name: string): boolean {
  return type === name
}

function serversOf(client: RpcClient): ReadonlyMap<ExecutionHostId, RpcClient> {
  return new Map([['runtime:env-1', client]])
}

async function flushUpdates(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('NewWorktreeModal on a server SSH repo', () => {
  let renderer: ReactTestRenderer

  afterEach(() => {
    act(() => renderer?.unmount())
  })

  it("connects and creates on a server's own SSH repo through that server", async () => {
    const serverSshRepo = {
      ...repos[0]!,
      id: 'server-ssh',
      path: '/home/dev/orca',
      connectionId: 'devbox'
    }
    const sshState = (status: string) =>
      Promise.resolve({
        ok: true,
        result: { state: { targetId: 'devbox', status, error: null, reconnectAttempt: 0 } }
      })
    const reply = (method: string, listed: unknown[], hostPlatform: string) => {
      if (method === 'repo.list') {
        return Promise.resolve({ ok: true, result: { repos: listed } })
      }
      if (method === 'status.get') {
        return Promise.resolve({ ok: true, result: { hostPlatform } })
      }
      if (method === 'ssh.getState') {
        return sshState('disconnected')
      }
      if (method === 'ssh.connect') {
        return sshState('connected')
      }
      if (method === 'worktree.create') {
        return Promise.resolve({
          ok: true,
          result: { worktree: { id: 'ssh-wt', displayName: 'ssh-wt', path: '/home/dev/ssh-wt' } }
        })
      }
      if (method === 'settings.get') {
        return Promise.resolve({ ok: true, result: { settings: {} } })
      }
      return Promise.resolve({ ok: true, result: {} })
    }
    const desktop = vi.fn((method: string) => reply(method, repos, 'darwin'))
    const server = vi.fn((method: string) => reply(method, [serverSshRepo], 'linux'))
    const onCreated = vi.fn()
    recordHostDescriptor('host-1', { machineName: null, platform: 'darwin' })

    await act(async () => {
      renderer = create(
        createElement(NewWorktreeModal, {
          visible: true,
          client: requestsOnly(desktop),
          serverClients: serversOf(requestsOnly(server)),
          hostId: 'host-1',
          hostLabelById: new Map<ExecutionHostId, string>([['runtime:env-1', 'scratch-server']]),
          onCreated,
          openExternalUrl: () => {},
          onClose: () => {}
        })
      )
    })
    await flushUpdates()

    expect(pickerItems(renderer, 'Run on').map((item) => [item.label, item.detail])).toEqual([
      [LOCAL_HOST_LABEL, '/src/orca'],
      ['scratch-server', '/home/dev/orca']
    ])
    const picker = runTargetPicker(renderer)
    await act(async () => picker.props.onSelect(picker.props.items[1]))
    await flushUpdates()
    expect(server).toHaveBeenCalledWith('ssh.getState', { targetId: 'devbox' })
    const canCreate = () =>
      renderer.root.find((node) => typeof node.props.onCreate === 'function').props.canCreate
    act(() => sourceInputs(renderer)[0]!.props.onChangeText('ssh-wt'))
    expect(canCreate()).toBe(false)

    const connectable = renderer.root.find((node) => typeof node.props.onConnect === 'function')
    await act(async () => connectable.props.onConnect())
    await flushUpdates()
    expect(canCreate()).toBe(true)
    expect(server).toHaveBeenCalledWith(
      'ssh.connect',
      { targetId: 'devbox' },
      expect.objectContaining({ timeoutMs: 120_000 })
    )
    expect(server).toHaveBeenCalledWith('preflight.detectRemoteAgents', { connectionId: 'devbox' })

    const form = renderer.root.find((node) => typeof node.props.onCreate === 'function')
    await act(async () => form.props.onCreate())
    await flushUpdates()

    expect(server).toHaveBeenCalledWith(
      'worktree.create',
      expect.objectContaining({ repo: 'id:server-ssh' }),
      expect.anything()
    )
    expect(onCreated).toHaveBeenCalledWith('ssh-wt', expect.any(String), undefined, 'runtime:env-1')
    // The server holds this SSH target, so the desktop is never asked about it.
    const desktopMethods = desktop.mock.calls.map(([method]) => method)
    expect(desktopMethods.filter((method) => method.startsWith('ssh.'))).toEqual([])
    expect(desktopMethods).not.toContain('preflight.detectRemoteAgents')
    expect(desktopMethods).not.toContain('worktree.create')
  })

  it("never shows the desktop's SSH state for a server target with the same id", async () => {
    const sshRepo = { ...repos[0]!, id: 'ssh-repo', path: '/home/dev/orca', connectionId: 'devbox' }
    const desktop = vi.fn((method: string) => {
      if (method === 'repo.list') {
        return Promise.resolve({ ok: true, result: { repos: [sshRepo] } })
      }
      if (method === 'ssh.getState') {
        return Promise.resolve({
          ok: true,
          result: {
            state: { targetId: 'devbox', status: 'connected', error: null, reconnectAttempt: 0 }
          }
        })
      }
      if (method === 'preflight.detectRemoteAgents') {
        return Promise.resolve({ ok: true, result: ['codex'] })
      }
      return new Promise(() => {})
    })
    // The server has not answered yet, so it has no state to show.
    const server = vi.fn((method: string) =>
      method === 'repo.list'
        ? Promise.resolve({ ok: true, result: { repos: [{ ...sshRepo, path: '/srv/orca' }] } })
        : new Promise(() => {})
    )

    await act(async () => {
      renderer = create(
        createElement(NewWorktreeModal, {
          visible: true,
          client: requestsOnly(desktop),
          serverClients: serversOf(requestsOnly(server)),
          hostId: 'host-same-ssh-id',
          onCreated: () => {},
          openExternalUrl: () => {},
          onClose: () => {}
        })
      )
    })
    await flushUpdates()
    const gate = () => renderer.root.find((node) => node.props.sshGate !== undefined).props.sshGate
    const picker = runTargetPicker(renderer)
    expect(picker.props.items.map((item: { id: string }) => item.id)).toEqual([
      'ssh:devbox',
      'runtime:env-1'
    ])
    await act(async () => picker.props.onSelect(picker.props.items[0]))
    await flushUpdates()
    expect(gate().status).toBe('connected')

    await act(async () => runTargetPicker(renderer).props.onSelect(picker.props.items[1]))
    await flushUpdates()

    expect(runTargetPicker(renderer).props.selectedId).toBe('runtime:env-1')
    expect(server).toHaveBeenCalledWith('ssh.getState', { targetId: 'devbox' })
    expect(gate()).toMatchObject({ status: null, requiresConnection: true })
    expect(server).not.toHaveBeenCalledWith('worktree.create', expect.anything(), expect.anything())
  })

  it("never offers a server's per-workspace-environment SSH repo, even last visited", async () => {
    const vmRepo = {
      ...repos[0]!,
      id: 'vm-repo',
      path: '/home/dev/vm-orca',
      connectionId: 'runtime-ssh-vm-1'
    }
    const serverRepo = { ...repos[0]!, id: 'server-repo', path: '/srv/orca' }
    asyncStorage.getItem.mockResolvedValueOnce(
      JSON.stringify({ hostId: 'host-vm', worktreeId: 'vm-repo::/home/dev/vm-orca/wt' })
    )
    const listing = (listed: unknown[]) =>
      vi.fn((method: string) =>
        method === 'repo.list'
          ? Promise.resolve({ ok: true, result: { repos: listed } })
          : new Promise(() => {})
      )

    await act(async () => {
      renderer = create(
        createElement(NewWorktreeModal, {
          visible: true,
          client: requestsOnly(listing([])),
          // Listed first, it would otherwise win the server's row.
          serverClients: serversOf(requestsOnly(listing([vmRepo, serverRepo]))),
          hostId: 'host-vm',
          onCreated: () => {},
          openExternalUrl: () => {},
          onClose: () => {}
        })
      )
    })
    await flushUpdates()

    expect(pickerItems(renderer, 'Run on').map((item) => item.detail)).toEqual(['/srv/orca'])
    expect(
      renderer.root.find((node) => node.props.runTarget !== undefined).props.runTarget?.detail
    ).toBe('/srv/orca')
  })

  it("gives a server's row to the first of its copies the server lists", async () => {
    const sshCopy = { ...repos[0]!, id: 'ssh-copy', path: '/home/dev/orca', connectionId: 'devbox' }
    const localCopy = { ...repos[0]!, id: 'local-copy', path: '/srv/orca' }
    const listing = (listed: unknown[]) =>
      vi.fn((method: string) =>
        method === 'repo.list'
          ? Promise.resolve({ ok: true, result: { repos: listed } })
          : new Promise(() => {})
      )

    await act(async () => {
      renderer = create(
        createElement(NewWorktreeModal, {
          visible: true,
          client: requestsOnly(listing(repos)),
          serverClients: serversOf(requestsOnly(listing([sshCopy, localCopy]))),
          hostId: 'host-1',
          onCreated: () => {},
          openExternalUrl: () => {},
          onClose: () => {}
        })
      )
    })
    await flushUpdates()

    expect(pickerItems(renderer, 'Run on').map((item) => item.detail)).toEqual([
      '/src/orca',
      '/home/dev/orca'
    ])
  })

  it("drops a connect reply that arrives after the server's target changed", async () => {
    const sshRepo = (id: string, connectionId: string) => ({
      ...repos[0]!,
      id,
      displayName: id,
      path: `/home/dev/${id}`,
      upstream: { owner: 'stablyai', repo: id },
      connectionId
    })
    const state = (targetId: string, status: string) => ({
      ok: true,
      result: { state: { targetId, status, error: null, reconnectAttempt: 0 } }
    })
    let finishConnect: ((reply: unknown) => void) | undefined
    const server = vi.fn((method: string, params?: { targetId?: string }) => {
      if (method === 'repo.list') {
        return Promise.resolve({
          ok: true,
          result: { repos: [sshRepo('alpha', 'box-a'), sshRepo('beta', 'box-b')] }
        })
      }
      if (method === 'ssh.getState') {
        return Promise.resolve(state(params!.targetId!, 'disconnected'))
      }
      if (method === 'ssh.connect') {
        return new Promise((resolve) => {
          finishConnect = resolve
        })
      }
      return new Promise(() => {})
    })

    await act(async () => {
      renderer = create(
        createElement(NewWorktreeModal, {
          visible: true,
          client: requestsOnly(vi.fn(() => new Promise(() => {}))),
          serverClients: serversOf(requestsOnly(server)),
          hostId: 'host-late-connect',
          onCreated: () => {},
          openExternalUrl: () => {},
          onClose: () => {}
        })
      )
    })
    await flushUpdates()
    const projects = () =>
      renderer.root
        .findAll((node) => isHost(node.type, 'PickerListDrawer'))
        .find((node) => node.props.title === 'Project')!
    const pickProject = async (label: string) => {
      const picker = projects()
      await act(async () =>
        picker.props.onSelect(
          picker.props.items.find((item: { label: string }) => item.label === label)
        )
      )
      await flushUpdates()
    }
    const gate = () => renderer.root.find((node) => node.props.sshGate !== undefined).props.sshGate
    await pickProject('alpha')
    const connectable = renderer.root.find((node) => typeof node.props.onConnect === 'function')
    await act(async () => connectable.props.onConnect())
    await pickProject('beta')
    expect(gate().status).toBe('disconnected')

    await act(async () => finishConnect!(state('box-a', 'connected')))
    await flushUpdates()

    expect(gate()).toMatchObject({ status: 'disconnected', requiresConnection: true })
  })
})
