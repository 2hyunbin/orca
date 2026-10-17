import { createElement, Fragment } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

const reactNative = vi.hoisted(() => ({
  Pressable: 'Pressable',
  StyleSheet: { create: <Styles,>(styles: Styles) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))
vi.mock('react-native', () => reactNative)
vi.mock('./mobile-tasks-dependencies', async () => ({
  ...reactNative,
  ...(await import('../theme/mobile-theme')),
  ChevronLeft: 'Icon',
  Plus: 'Icon',
  RefreshCw: 'Icon',
  StatusDot: 'StatusDot'
}))
vi.mock('./mobile-tasks-legacy-styles', async () => ({
  styles: (await import('./mobile-tasks-chrome-styles')).mobileTasksChromeStyles
}))
vi.mock('./mobile-tasks-provider-controls', () => ({
  renderMobileTasksProviderControls: () => null
}))
vi.mock('./mobile-tasks-search-control', () => ({ renderMobileTasksSearchControl: () => null }))
vi.mock('../transport/host-store', () => ({
  loadHosts: async () => [
    { id: 'studio', name: 'Studio Mac' },
    { id: 'buildbox', name: 'Build Box' }
  ]
}))

import { hostScreenStyles } from '../host-screen/host-screen-styles'
import { renderMobileTasksStatusBar } from './mobile-tasks-screen-chrome'
import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'

let renderer: ReactTestRenderer | null = null

async function renderStatusBar(hostId: string): Promise<ReactTestRenderer> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the status bar reads only the fields set here.
  const model = {
    connState: 'connected',
    hostId,
    router: { back: () => {} },
    taskUiReady: true
  } as unknown as ConnectionPresentationModel
  function StatusBar() {
    return createElement(Fragment, null, renderMobileTasksStatusBar(model))
  }
  await act(async () => {
    renderer = create(createElement(StatusBar))
  })
  return renderer!
}

describe('Tasks header desktop subtitle', () => {
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('names the desktop under the Tasks title in the host screen subtitle style', async () => {
    const tree = await renderStatusBar('buildbox')
    const subtitle = tree.root.findByProps({ children: 'Build Box' })
    expect(subtitle.props.style).toBe(hostScreenStyles.hostPlatformText)
    expect(subtitle.props.numberOfLines).toBe(1)
    const titleWrap = subtitle.parent!.parent!
    expect(titleWrap.findByProps({ children: 'Tasks' }).props.style).toBeDefined()
  })

  it('shows no subtitle for a desktop that is not paired', async () => {
    const tree = await renderStatusBar('gone')
    expect(
      tree.root.findAll((node) => node.props.style === hostScreenStyles.hostPlatformText)
    ).toHaveLength(0)
  })
})
