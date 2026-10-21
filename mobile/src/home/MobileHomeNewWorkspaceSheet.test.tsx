import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostProfile } from '../transport/types'

vi.mock('react-native', () => ({
  Alert: { alert: vi.fn() },
  Pressable: 'Pressable',
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: 'Text',
  View: 'View'
}))
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: ReactNode }) => children,
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))
vi.mock('lucide-react-native', () => ({
  ChevronRight: 'ChevronRight',
  ListTodo: 'ListTodo',
  Plus: 'Plus',
  QrCode: 'QrCode'
}))

const navigation = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  const committed: { state: unknown } = {
    state: { index: 0, routes: [{ name: 'index', key: 'home' }] }
  }
  return {
    listeners,
    committed,
    router: { push: vi.fn(), replace: vi.fn() },
    root: {
      addListener: (_event: 'state', listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      dispatch: vi.fn(),
      getState: () => committed.state
    }
  }
})
vi.mock('expo-router', () => ({
  useNavigation: () => navigation.root,
  useRouter: () => navigation.router
}))

vi.mock('../components/ActionSheetModal', () => ({ ActionSheetModal: 'ActionSheetModal' }))
vi.mock('../components/ConfirmModal', () => ({ ConfirmModal: 'ConfirmModal' }))
vi.mock('../components/PickerModal', () => ({ PickerModal: 'PickerModal' }))
vi.mock('../components/TaskProviderLogo', () => ({ TaskProviderLogo: 'TaskProviderLogo' }))
vi.mock('../components/NewWorktreeModalController', () => ({
  NewWorktreeModalController: 'NewWorktreeModalController'
}))
vi.mock('./MobileHomeTopBar', () => ({ MobileHomeTopBar: 'MobileHomeTopBar' }))
vi.mock('./MobileHomeEmptyState', () => ({ MobileHomeEmptyState: 'MobileHomeEmptyState' }))
vi.mock('./MobileHomeResumeCard', () => ({ MobileHomeResumeCard: 'MobileHomeResumeCard' }))
vi.mock('./MobileHomeAccountUsageCards', () => ({
  MobileHomeAccountUsageCards: 'MobileHomeAccountUsageCards'
}))
vi.mock('./MobileHomeHostList', () => ({
  MobileHomeHostList: ({ footer }: { footer: ReactNode }) => footer
}))
vi.mock('../accounts/use-open-mobile-accounts', () => ({ useOpenMobileAccounts: () => vi.fn() }))
vi.mock('../tasks/use-open-mobile-tasks', () => ({ useOpenMobileTasks: () => vi.fn() }))
vi.mock('../transport/use-open-mobile-host-edit', () => ({ useOpenMobileHostEdit: () => vi.fn() }))
vi.mock('../transport/host-removal-lifecycle', () => ({ removeHostAndCloseClient: vi.fn() }))
vi.mock('../transport/host-store', () => ({ loadHostCatalog: vi.fn() }))
vi.mock('../platform/haptics', () => ({ triggerMediumImpact: vi.fn() }))
vi.mock('../platform/external-link', () => ({ openExternalLink: vi.fn() }))
vi.mock('../layout/responsive-layout', () => ({
  useResponsiveLayout: () => ({ isWideLayout: false, contentMaxWidth: undefined })
}))
vi.mock('../transport/home-host-auto-connect', () => ({
  resolveHomeHostConnectionState: () => 'connected'
}))
vi.mock('../transport/host-client-hooks', () => ({
  useDisconnectHostClient: () => vi.fn(),
  useForceReconnect: () => vi.fn(),
  useForgetHostClient: () => vi.fn(),
  useHostClient: () => ({ client: null, clientId: null, state: 'connected' })
}))
vi.mock('../transport/host-status-gates', () => ({
  useHostStatusGates: () => ({ hostCapabilities: [], compatVerdict: { kind: 'ok' } })
}))

function host(id: string, name: string): HostProfile {
  return {
    id,
    name,
    endpoint: `ws://${id}.local:6768`,
    deviceToken: `token-${id}`,
    publicKeyB64: `key-${id}`,
    lastConnected: 1
  }
}
const hosts = [host('desk', 'Desk'), host('laptop', 'Laptop')]

vi.mock('./use-mobile-home-data', () => ({
  useMobileHomeData: () => ({
    accountsHosts: [],
    autoConnectHostIds: new Set(),
    connectedHosts: hosts,
    hostAttempts: {},
    hostCatalog: hosts,
    hostConnections: {},
    hostLastConnected: {},
    hostStates: {},
    resumeCard: null,
    router: navigation.router,
    setHostCatalog: vi.fn(),
    sortedHostCatalog: hosts,
    stats: null,
    taskProvidersByHost: {},
    worktreeInfo: {}
  })
}))

import { setCachedWorktrees } from '../cache/worktree-cache'
import { MobileHomeScreen } from './MobileHomeScreen'

describe('Home New Workspace', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it("opens the create sheet over Home for the picked desktop, then opens the new workspace's session", async () => {
    await act(async () => {
      renderer = create(createElement(MobileHomeScreen))
    })
    const root = renderer!.root
    const sheet = () => root.findAll((node) => String(node.type) === 'NewWorktreeModalController')
    const picker = () =>
      root.find(
        (node) => String(node.type) === 'PickerModal' && node.props.title === 'Create Workspace On'
      )
    const newWorkspace = root
      .findAll((node) => String(node.type) === 'Pressable')
      .find((node) => node.findAll((text) => text.props.children === 'New Workspace').length > 0)!

    // Home's cold-start seed: a resume row with no path, which the name picker cannot read.
    setCachedWorktrees('laptop', [{ worktreeId: 'wt-0', displayName: 'Marlin' }])

    act(() => newWorkspace.props.onPress())
    act(() => picker().props.onSelect('laptop'))
    act(() => picker().props.onAfterClose())

    expect(sheet()).toHaveLength(1)
    expect(sheet()[0]!.props).toMatchObject({
      visible: true,
      hostId: 'laptop',
      existingWorktreePaths: []
    })
    expect(navigation.router.push).not.toHaveBeenCalled()

    // The modal closes itself before reporting the create, as the real one does.
    act(() => {
      sheet()[0]!.props.onClose()
      sheet()[0]!.props.onCreated('wt-1', 'Hammerhead', 'No startup terminal')
    })
    expect(sheet()).toHaveLength(0)
    expect(navigation.router.push).toHaveBeenCalledWith('/h/laptop')

    // The host stack commits; the pending open replaces its index with the session.
    navigation.committed.state = {
      index: 0,
      routes: [
        {
          name: 'h',
          key: 'h',
          state: {
            key: 'host-stack',
            index: 0,
            routes: [{ name: '[hostId]/index', key: 'host-index', params: { hostId: 'laptop' } }]
          }
        }
      ]
    }
    act(() => navigation.listeners.forEach((listener) => listener()))
    expect(navigation.root.dispatch).toHaveBeenCalledWith({
      type: 'REPLACE',
      target: 'host-stack',
      source: 'host-index',
      payload: {
        name: '[hostId]/session/[worktreeId]',
        params: {
          hostId: 'laptop',
          worktreeId: 'wt-1',
          name: 'Hammerhead',
          created: '1',
          warning: 'No startup terminal'
        }
      }
    })
  })
})
