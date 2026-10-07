import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import type { MobileNativeChatTab } from './mobile-native-chat-eligibility'
import { useMobileNativeChatActiveResolution } from './use-mobile-native-chat-active-resolution'

const visibility = vi.hoisted(() => ({ chat: true }))
vi.mock('./use-mobile-session-view-mode', () => ({
  useMobileSessionViewMode: () => ({
    isTabChatView: () => visibility.chat,
    toggleTabChatView: () => {}
  })
}))

it('scopes the transcript to host/workspace/tab/provider conversation rather than handle or status', () => {
  let identity = ''
  const handle = { current: 'handle-1' }
  const tab: MobileNativeChatTab = {
    type: 'terminal',
    launchAgent: 'claude',
    agentStatus: {
      state: 'working',
      prompt: '',
      updatedAt: 0,
      stateStartedAt: 0,
      paneKey: 'tab:leaf',
      stateHistory: [],
      agentType: 'claude',
      providerSession: { id: 'provider-1' }
    }
  }
  function Harness({ host = 'host', workspace = 'folder:workspace', tabId = 'tab' }) {
    identity = useMobileNativeChatActiveResolution({
      hostId: host,
      worktreeId: workspace,
      activeSessionTab: tab,
      activeSessionTabId: tabId,
      activeHandleRef: handle,
      nativeChatTranscriptIsLocalReadable: true
    }).transcriptIdentity
    return null
  }
  let renderer: ReturnType<typeof create>
  act(() => {
    renderer = create(createElement(Harness, {}))
  })
  const first = identity
  handle.current = 'reconnected-handle'
  if (!tab.agentStatus) {
    throw new Error('Missing status fixture')
  }
  tab.agentStatus.lastAssistantMessage = 'reply changed'
  tab.agentStatus.state = 'done'
  act(() => renderer!.update(createElement(Harness, {})))
  expect(identity).toBe(first)
  visibility.chat = false
  act(() => renderer!.update(createElement(Harness, {})))
  expect(identity).toBe(first)
  visibility.chat = true
  tab.agentStatus.providerSession = { id: 'provider-2' }
  act(() => renderer!.update(createElement(Harness, {})))
  expect(identity).not.toBe(first)
  const second = identity
  act(() => renderer!.update(createElement(Harness, { tabId: 'other-tab' })))
  expect(identity).not.toBe(second)
  const otherTab = identity
  act(() => renderer!.update(createElement(Harness, { tabId: 'other-tab', host: 'other-host' })))
  expect(identity).not.toBe(otherTab)
  const otherHost = identity
  act(() =>
    renderer!.update(
      createElement(Harness, { tabId: 'other-tab', host: 'other-host', workspace: 'workspace-2' })
    )
  )
  expect(identity).not.toBe(otherHost)
  act(() => renderer!.unmount())
})
