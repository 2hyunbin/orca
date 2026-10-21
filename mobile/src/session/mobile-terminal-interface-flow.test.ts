import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import type { TerminalInterfaceObservation } from '../../../src/shared/terminal-interface-observation'
import {
  mobileTerminalInterfaceReleasesChat,
  type MobileNativeChatTab
} from './mobile-native-chat-eligibility'
import { mobileSessionTabsEqual } from './mobile-terminal-records'

vi.mock('lucide-react-native', () => ({ MessageSquare: () => null, SquareTerminal: () => null }))
vi.mock('./use-mobile-session-view-mode', async () => {
  const { useCallback, useState } = await import('react')
  return {
    useMobileSessionViewMode: () => {
      const [chat, setChat] = useState(true)
      const setTabView = useCallback((_id: string, view: string) => setChat(view === 'chat'), [])
      return {
        isTabChatView: () => chat,
        setTabView,
        toggleTabChatView: () => setChat((value) => !value)
      }
    }
  }
})
import { useMobileNativeChatActiveResolution } from './use-mobile-native-chat-active-resolution'
import { getMobileNativeChatToggleActions } from './mobile-native-chat-toggle-action'

it('moves active Chat and its stream back to the terminal on qualified rowless host release, while pending and old-host tabs remain usable', async () => {
  const observation: TerminalInterfaceObservation = {
    ptyId: 'physical',
    incarnationId: 'birth',
    terminalHandle: 'handle',
    paneKey: 'tab:11111111-1111-4111-8111-111111111111',
    worktreeId: 'folder:one',
    epoch: 'mobile-flow',
    revision: 1,
    inputRevision: 0,
    owner: null,
    executionLaunchToken: null,
    state: 'unverifiable',
    basis: 'process'
  }
  let tab: MobileNativeChatTab & { id: string; terminal: string } = {
    type: 'terminal',
    id: 'tab',
    terminal: 'handle',
    status: 'ready',
    incarnationId: 'birth',
    launchAgent: 'codex',
    terminalInterface: observation
  }
  const values: ReturnType<typeof useMobileNativeChatActiveResolution>[] = []
  function Probe() {
    values.push(
      useMobileNativeChatActiveResolution({
        hostId: 'host',
        worktreeId: 'folder:one',
        activeSessionTab: tab,
        activeSessionTabId: tab.id,
        activeHandleRef: { current: tab.terminal },
        nativeChatTranscriptIsLocalReadable: true
      })
    )
    return null
  }
  let renderer: ReactTestRenderer | null = null
  const menu = () =>
    getMobileNativeChatToggleActions({
      terminalHandle: 'handle',
      tabs: [tab],
      isTabChatView: () => false,
      nativeChatTranscriptIsLocalReadable: true,
      onClose: () => {},
      onToggle: () => {}
    })
  try {
    await act(async () => {
      renderer = create(createElement(Probe))
    })
    expect(values.at(-1)?.showNativeChat).toBe(true)
    expect(menu()).toHaveLength(1)
    // Host launch/resume/recovery protection is an unverifiable interface, independent of drafts.
    tab = { ...tab, terminalInterface: { ...observation, revision: 2 } }
    await act(async () => renderer?.update(createElement(Probe)))
    expect(values.at(-1)?.showNativeChat).toBe(true)
    tab = { ...tab, terminalInterface: { ...observation, revision: 3, state: 'shell' } }
    await act(async () => renderer?.update(createElement(Probe)))
    expect(values.at(-1)?.showNativeChat).toBe(false)
    expect(values.at(-1)?.showNativeChatRef.current).toBe(false)
    expect(values.at(-1)?.isTabChatView('tab')).toBe(false)
    expect(menu()).toEqual([])
    expect(mobileTerminalInterfaceReleasesChat(tab)).toBe(true)
    expect(mobileTerminalInterfaceReleasesChat({ ...tab, launchDraft: 'pending' })).toBe(false)
    const projected = { ...tab, terminal: 'handle', title: 'Shell', isActive: true }
    expect(mobileSessionTabsEqual([projected], [{ ...projected }])).toBe(true)
    expect(
      mobileSessionTabsEqual([projected], [{ ...projected, terminalInterface: undefined }])
    ).toBe(false)
    // Omitted old-host field preserves the prior launch/transcript resolver and toggle.
    tab = { ...tab, terminalInterface: undefined }
    expect(menu()).toHaveLength(1)
  } finally {
    await act(async () => renderer?.unmount())
  }
})
