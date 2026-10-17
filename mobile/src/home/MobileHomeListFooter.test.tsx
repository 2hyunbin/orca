import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TaskProvider } from '../../../src/shared/task-providers'
import type { HostProfile } from '../transport/types'
import { MobileHomeListFooter } from './MobileHomeListFooter'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: 'Text',
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({
  ChevronRight: 'ChevronRight',
  ListTodo: 'ListTodo',
  Plus: 'Plus',
  QrCode: 'QrCode'
}))

vi.mock('../components/TaskProviderLogo', () => ({ TaskProviderLogo: 'TaskProviderLogo' }))
vi.mock('./MobileHomeResumeCard', () => ({ MobileHomeResumeCard: 'MobileHomeResumeCard' }))
vi.mock('./MobileHomeAccountUsageCards', () => ({
  MobileHomeAccountUsageCards: 'MobileHomeAccountUsageCards'
}))

vi.mock('../components/PickerModal', () => ({ PickerModal: 'PickerModal' }))

function host(id: string, name: string, endpoint: string): HostProfile {
  return {
    id,
    name,
    endpoint,
    deviceToken: `token-${id}`,
    publicKeyB64: `key-${id}`,
    lastConnected: 1
  }
}

const desk = host('desk', 'Desk', 'ws://192.168.1.2:6768')
const laptop = host('laptop', 'Laptop', 'wss://relay.example.com/mobile')

describe('MobileHomeListFooter tasks', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.restoreAllMocks()
  })

  async function renderFooter(connectedHosts: HostProfile[]) {
    const onOpenTasks = vi.fn()
    const onCreateWorkspace = vi.fn()
    const providers: TaskProvider[] = ['github', 'jira']
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (typeof args[0] !== 'string' || !args[0].includes('react-test-renderer is deprecated')) {
        throw new Error(String(args[0]))
      }
    })
    await act(async () => {
      renderer = create(
        createElement(MobileHomeListFooter, {
          accountsHosts: [],
          connectedHosts,
          connectedTaskProviders: providers,
          resumeCard: null,
          onCreateWorkspace,
          onOpenAccounts: vi.fn(),
          onOpenResume: vi.fn(),
          onOpenTasks,
          onPairDesktop: vi.fn()
        })
      )
    })
    consoleError.mockRestore()
    return { onOpenTasks, onCreateWorkspace }
  }

  function pressablesWithLabel(label: string) {
    return renderer!.root
      .findAll((node) => String(node.type) === 'Pressable')
      .filter((node) => node.props.accessibilityLabel === label)
  }

  function tasksCard() {
    const card = renderer!.root
      .findAll((node) => String(node.type) === 'Pressable')
      .find((node) =>
        node
          .findAll((node) => String(node.type) === 'Text')
          .some((text) => text.props.children === 'Tasks')
      )
    if (!card) {
      throw new Error('Tasks card not rendered')
    }
    return card
  }

  function newWorkspaceButton() {
    const button = renderer!.root
      .findAll((node) => String(node.type) === 'Pressable')
      .find((node) =>
        node
          .findAll((node) => String(node.type) === 'Text')
          .some((text) => text.props.children === 'New Workspace')
      )
    if (!button) {
      throw new Error('New Workspace not rendered')
    }
    return button
  }

  function picker(title: string) {
    return renderer!.root
      .findAll((node) => String(node.type) === 'PickerModal')
      .find((node) => node.props.title === title)!
  }

  it('opens the only connected host directly', async () => {
    const callbacks = await renderFooter([desk])

    act(() => tasksCard().props.onPress())

    expect(callbacks.onOpenTasks).toHaveBeenCalledWith('desk', undefined)
    expect(picker('Open Tasks On').props.visible).toBe(false)
  })

  it('asks which host to open when several are connected', async () => {
    const callbacks = await renderFooter([desk, laptop])

    act(() => tasksCard().props.onPress())

    expect(callbacks.onOpenTasks).not.toHaveBeenCalled()
    expect(picker('Open Tasks On').props.visible).toBe(true)
    expect(picker('Open Tasks On').props.options).toEqual([
      { value: 'desk', label: 'Desk', subtitle: '192.168.1.2:6768' },
      { value: 'laptop', label: 'Laptop', subtitle: 'relay.example.com' }
    ])

    act(() => picker('Open Tasks On').props.onSelect('laptop'))
    expect(callbacks.onOpenTasks).not.toHaveBeenCalled()
    act(() => picker('Open Tasks On').props.onAfterClose())

    expect(callbacks.onOpenTasks).toHaveBeenCalledWith('laptop', undefined)
  })

  it('opens the tapped provider on the picked host', async () => {
    const callbacks = await renderFooter([desk, laptop])

    const [jira] = pressablesWithLabel('Open Jira tasks')
    act(() => jira.props.onPress({ stopPropagation: () => {} }))
    expect(picker('Open Tasks On').props.visible).toBe(true)

    act(() => picker('Open Tasks On').props.onSelect('laptop'))
    act(() => picker('Open Tasks On').props.onAfterClose())

    expect(callbacks.onOpenTasks).toHaveBeenCalledWith('laptop', 'jira')
  })

  it('opens nothing when the picker is dismissed', async () => {
    const callbacks = await renderFooter([desk, laptop])

    act(() => tasksCard().props.onPress())
    act(() => picker('Open Tasks On').props.onClose())
    act(() => picker('Open Tasks On').props.onAfterClose())

    expect(picker('Open Tasks On').props.visible).toBe(false)
    expect(callbacks.onOpenTasks).not.toHaveBeenCalled()
  })

  it('keeps the New Workspace picker separate from the Tasks picker', async () => {
    const callbacks = await renderFooter([desk, laptop])

    act(() => newWorkspaceButton().props.onPress())
    expect(picker('Create Workspace On').props.visible).toBe(true)
    expect(picker('Open Tasks On').props.visible).toBe(false)

    act(() => picker('Create Workspace On').props.onSelect('desk'))
    act(() => picker('Create Workspace On').props.onAfterClose())

    expect(callbacks.onCreateWorkspace).toHaveBeenCalledWith('desk')
    expect(callbacks.onOpenTasks).not.toHaveBeenCalled()
  })
})
