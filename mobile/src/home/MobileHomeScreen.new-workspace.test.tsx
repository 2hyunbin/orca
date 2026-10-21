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

const navigation = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn() },
  root: { addListener: () => () => {}, dispatch: vi.fn(), getState: () => undefined }
}))
vi.mock('expo-router', () => ({
  useNavigation: () => navigation.root,
  useRouter: () => navigation.router
}))

vi.mock('../components/ActionSheetModal', () => ({ ActionSheetModal: 'ActionSheetModal' }))
vi.mock('../components/ConfirmModal', () => ({ ConfirmModal: 'ConfirmModal' }))
vi.mock('../components/PickerModal', () => ({ PickerModal: 'PickerModal' }))
vi.mock('../components/TaskProviderLogo', () => ({ TaskProviderLogo: 'TaskProviderLogo' }))
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

import { MobileHomeScreen } from './MobileHomeScreen'

describe('Home New Workspace', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('opens the New Workspace overlay over Home, offering the connected desktops in order', async () => {
    await act(async () => {
      renderer = create(createElement(MobileHomeScreen))
    })
    const newWorkspace = renderer!.root
      .findAll((node) => String(node.type) === 'Pressable')
      .find((node) => node.findAll((text) => text.props.children === 'New Workspace').length > 0)!

    act(() => newWorkspace.props.onPress())

    expect(navigation.router.push).toHaveBeenCalledWith({
      pathname: '/new-workspace',
      params: { hostIds: 'desk,laptop' }
    })
  })
})
