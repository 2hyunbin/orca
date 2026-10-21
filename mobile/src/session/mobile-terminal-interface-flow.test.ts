import { createElement, useCallback, useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import type { TerminalInterfaceObservation } from '../../../src/shared/terminal-interface-observation'
import {
  mobileTerminalInterfaceReleasesChat,
  type MobileNativeChatTab
} from './mobile-native-chat-eligibility'
import { useMobileNativeChatLaunchDraftSeed } from './use-mobile-native-chat-launch-draft-seed'
import { mobileNativeChatLaunchDraftSeeds } from './mobile-native-chat-draft-store'
import { mobileSessionTabsEqual, type MobileTerminalSessionTab } from './mobile-terminal-records'

vi.mock('lucide-react-native', () => ({ MessageSquare: () => null, SquareTerminal: () => null }))
vi.mock('./use-mobile-session-view-mode', async () => {
  const { useCallback, useState } = await import('react')
  return {
    useMobileSessionViewMode: () => {
      const [chat, setChat] = useState(true)
      const setTabView = useCallback((_id: string, view: string) => setChat(view === 'chat'), [])
      return {
        ready: true,
        isTabChatView: () => chat,
        setTabView,
        toggleTabChatView: () => setChat((value) => !value)
      }
    }
  }
})
import { useMobileNativeChatActiveResolution } from './use-mobile-native-chat-active-resolution'
import { getMobileNativeChatToggleActions } from './mobile-native-chat-toggle-action'

it.each([undefined, 'Keep this editable'])(
  'moves active Chat and its stream back to the terminal on qualified rowless host release, while real producer pending shapes and old-host tabs remain usable (draft=%s)',
  async (launchDraft) => {
    mobileNativeChatLaunchDraftSeeds.clear()
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
      state: 'shell',
      basis: 'cold'
    }
    let tab: MobileTerminalSessionTab & Pick<MobileNativeChatTab, 'launchAgent'> = {
      type: 'terminal',
      id: 'tab',
      title: 'Agent',
      isActive: true,
      terminal: null,
      status: 'pending-handle',
      incarnationId: 'birth',
      launchAgent: 'codex',
      launchDraft,
      terminalInterface: undefined
    }
    const values: ReturnType<typeof useMobileNativeChatActiveResolution>[] = []
    let draftText = ''
    let editDraft: (text: string) => void = () => {}
    function Probe() {
      const [draft, setDraft] = useState('')
      draftText = draft
      editDraft = setDraft
      const setDraftText = useCallback(
        (_key: string, update: import('react').SetStateAction<string>) => setDraft(update),
        []
      )
      const resolution = useMobileNativeChatActiveResolution({
        hostId: 'host',
        worktreeId: 'folder:one',
        activeSessionTab: tab,
        activeSessionTabId: tab.id,
        activeHandleRef: { current: tab.terminal },
        nativeChatTranscriptIsLocalReadable: true
      })
      values.push(resolution)
      useMobileNativeChatLaunchDraftSeed({
        draftKey: 'terminal-interface-flow',
        messages: [],
        launchDraft: tab.launchDraft,
        chatActive: resolution.showNativeChat,
        setDraftText
      })
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
      expect(menu()).toEqual([])
      // These are the pending-handle and new cold binding shapes exercised through
      // the real new-tab/folder producers and host projection in the root flow tests.
      tab = { ...tab, terminal: 'handle', status: 'ready', terminalInterface: observation }
      await act(async () => renderer?.update(createElement(Probe)))
      expect(values.at(-1)?.showNativeChat).toBe(true)
      expect(menu()).toHaveLength(1)
      tab = {
        ...tab,
        terminalInterface: { ...observation, revision: 2, state: 'agent', basis: 'hook' }
      }
      await act(async () => renderer?.update(createElement(Probe)))
      expect(values.at(-1)?.showNativeChat).toBe(true)
      expect(draftText).toBe(launchDraft ?? '')
      if (launchDraft) {
        await act(async () => editDraft('My edited context'))
      }
      tab = {
        ...tab,
        terminalInterface: { ...observation, revision: 3, state: 'shell', basis: 'hook' }
      }
      await act(async () => renderer?.update(createElement(Probe)))
      expect(values.at(-1)?.showNativeChat).toBe(false)
      expect(values.at(-1)?.showNativeChatRef.current).toBe(false)
      expect(values.at(-1)?.isTabChatView('tab')).toBe(false)
      expect(menu()).toEqual([])
      expect(mobileTerminalInterfaceReleasesChat(tab)).toBe(true)
      expect(mobileTerminalInterfaceReleasesChat({ ...tab, launchDraft: 'unsent context' })).toBe(
        true
      )
      expect(tab.launchDraft).toBe(launchDraft)
      expect(draftText).toBe(launchDraft ? 'My edited context' : '')
      expect(values.at(-1)?.activeChatAgentRef.current).toBeNull()
      expect(values.at(-1)?.activeChatResolution).toBeNull()
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
  }
)
