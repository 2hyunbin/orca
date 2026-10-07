import React, { useEffect, useImperativeHandle, useRef } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileNativeChatView, type MobileNativeChatViewProps } from './MobileNativeChatView'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'

const state = vi.hoisted(() => ({ jumps: vi.fn(), composerMounts: 0 }))
vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: (styles: unknown) => styles },
  Platform: { OS: 'ios' }
}))
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }))
vi.mock('react-native-gesture-handler', () => ({
  GestureDetector: 'GestureDetector',
  GestureHandlerRootView: 'GestureRoot'
}))
vi.mock('lucide-react-native', () => ({
  ArrowDown: 'ArrowDown',
  ChevronsDownUp: 'Collapse',
  ChevronsUpDown: 'Expand'
}))
vi.mock('./use-mobile-native-chat-pinch-gesture', () => ({
  useMobileNativeChatPinchGesture: () => ({ fontScale: 1, pinchGesture: {} })
}))
vi.mock('./use-mobile-native-chat-input-lease', () => ({
  useSettledMobileNativeChatInputLock: () => null,
  mobileNativeChatComposerPlaceholder: () => 'Message'
}))
vi.mock('./use-mobile-native-chat-queued-slot', () => ({
  NO_QUEUED_SLOT: { cards: null, composerInputRef: { current: null } }
}))
vi.mock('./MobileNativeChatComposer', () => ({
  MobileNativeChatComposer: (props: object) => {
    useEffect(() => {
      state.composerMounts++
    }, [])
    const input = useRef({ focused: true })
    return React.createElement('Composer', { ...props, input: input.current })
  }
}))
vi.mock('./MobileNativeChatPromptCard', () => ({ MobileNativeChatPromptCard: 'PromptCard' }))
vi.mock('./MobileNativeChatStopButton', () => ({ MobileNativeChatStopButton: 'StopButton' }))
vi.mock('./MobileAgentWorkingIndicator', () => ({ MobileAgentWorkingIndicator: 'Working' }))
vi.mock('./MobileNativeChatMessage', () => ({ MobileNativeChatMessage: 'Message' }))
vi.mock('./MobileNativeChatLiveLine', () => ({ MobileNativeChatLiveLine: 'LiveLine' }))
// An inert list proves routing and handlers only, never native fill or anchoring.
vi.mock('@legendapp/list/react-native', () => ({
  LegendList: (props: { ref: React.Ref<unknown> }) => {
    useImperativeHandle(props.ref, () => ({ scrollToEnd: state.jumps }), [])
    return React.createElement('MeasuredList', props)
  }
}))

const message: NativeChatMessage = {
  id: 'u',
  role: 'user',
  blocks: [{ type: 'text', text: 'hello' }],
  timestamp: 0,
  source: 'transcript'
}
function props(overrides: Partial<MobileNativeChatViewProps> = {}): MobileNativeChatViewProps {
  return {
    messages: [message],
    folded: [message],
    pending: [],
    status: 'ready',
    streaming: null,
    streamingKey: 'streaming:0',
    presentationKeys: {},
    transcriptIdentity: 'chat-a',
    sendSurfaceId: 'tab-a',
    onSend: async () => true,
    composerText: 'draft',
    onComposerTextChange: vi.fn(),
    getSendCompletionGeneration: () => 0,
    getComposerEditGeneration: () => 0,
    ...overrides
  }
}
function event(y: number) {
  return {
    nativeEvent: {
      contentOffset: { y, x: 0 },
      contentSize: { height: 2000, width: 800 },
      layoutMeasurement: { height: 500, width: 800 },
      contentInset: { top: 0, left: 0, right: 0, bottom: 0 },
      zoomScale: 1
    }
  }
}
let renderer: ReactTestRenderer
async function render(input = props()) {
  await act(async () => {
    renderer = create(<MobileNativeChatView {...input} />)
  })
}
const list = () => renderer.root.findByType('MeasuredList')
const composer = () => renderer.root.findByType('Composer')
afterEach(async () => {
  if (renderer) {
    await act(async () => renderer.unmount())
  }
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('transcript scope with retained composer', () => {
  it('starts another conversation at newest while reconnect retains intent, input focus and draft', async () => {
    await render()
    const input = composer().props.input
    const mounts = state.composerMounts
    await act(async () => {
      list().props.onScrollBeginDrag(event(900))
      list().props.onMomentumScrollEnd(event(900))
    })
    expect(list().props.maintainScrollAtEnd).toBe(false)
    await act(async () =>
      renderer.update(<MobileNativeChatView {...props({ error: 'Reconnecting' })} />)
    )
    expect(list().props.maintainScrollAtEnd).toBe(false)
    await act(async () =>
      renderer.update(
        <MobileNativeChatView
          {...props({ transcriptIdentity: 'chat-b', sendSurfaceId: 'tab-b' })}
        />
      )
    )
    expect(list().props.maintainScrollAtEnd).toEqual({ animated: false })
    expect(composer().props.value).toBe('draft')
    expect(composer().props.input).toBe(input)
    expect(state.composerMounts).toBe(mounts)
  })
  it('fences stale acceptance before clearing an error or jumping another transcript', async () => {
    let accept: (accepted: boolean) => void = () => {}
    const onSend = () =>
      new Promise<boolean>((resolve) => {
        accept = resolve
      })
    const clear = vi.fn()
    await render(props({ onSend, onClearSendError: clear }))
    const sending = composer().props.onSend('a')
    await act(async () =>
      renderer.update(
        <MobileNativeChatView
          {...props({ transcriptIdentity: 'chat-b', sendSurfaceId: 'tab-b' })}
        />
      )
    )
    await act(async () => {
      accept(true)
      await sending
    })
    expect(clear).not.toHaveBeenCalled()
    expect(state.jumps).not.toHaveBeenCalled()
  })
  it('fences blur and resumes latest for a current acceptance', async () => {
    let generation = 0
    let accept: (accepted: boolean) => void = () => {}
    const clear = vi.fn()
    await render(
      props({
        onSend: () =>
          new Promise((resolve) => {
            accept = resolve
          }),
        onClearSendError: clear,
        getSendCompletionGeneration: () => generation
      })
    )
    const stale = composer().props.onSend('a')
    generation++
    await act(async () => {
      accept(true)
      await stale
    })
    expect(clear).not.toHaveBeenCalled()
    const current = composer().props.onSend('a')
    await act(async () => {
      accept(true)
      await current
    })
    expect(clear).toHaveBeenCalledOnce()
    expect(state.jumps).toHaveBeenCalledOnce()
  })
})

describe('user-only paging and independent momentum', () => {
  it('initial and layout edges never page or detach', async () => {
    const load = vi.fn()
    await render(props({ hasMore: true, onLoadEarlier: load }))
    await act(async () => {
      list().props.onScroll(event(0))
      list().props.onScroll(event(1500))
    })
    expect(load).not.toHaveBeenCalled()
    expect(list().props.maintainScrollAtEnd).toEqual({ animated: false })
    expect(list().props.initialScrollAtEnd).toBe(true)
    expect(list().props.maintainVisibleContentPosition).toMatchObject({ data: true, size: true })
    expect(list().props.onContentSizeChange).toBeUndefined()
    expect(list().props.onLayout).toBeUndefined()
    expect(list().props.ListFooterComponent).toBeUndefined()
  })
  it('failed or refused pages retry at the same head; the existing button works', async () => {
    const load = vi.fn()
    await render(props({ hasMore: true, onLoadEarlier: load }))
    for (let attempt = 0; attempt < 2; attempt++) {
      await act(async () => {
        list().props.onScrollBeginDrag(event(100))
        list().props.onScroll(event(40))
        list().props.onMomentumScrollEnd(event(40))
      })
    }
    expect(load).toHaveBeenCalledTimes(2)
    await act(async () => list().props.ListHeaderComponent.props.onPress())
    expect(load).toHaveBeenCalledTimes(3)
  })
  it('late and independent momentum revoke follow; jump resumes latest', async () => {
    const frames = new Map<number, FrameRequestCallback>()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(1, callback)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
    await render()
    await act(async () => {
      list().props.onScrollBeginDrag(event(1500))
      list().props.onScrollEndDrag(event(1500))
    })
    await act(async () => {
      frames.get(1)?.(0)
    })
    expect(list().props.maintainScrollAtEnd).toEqual({ animated: false })
    await act(async () => {
      list().props.onMomentumScrollBegin(event(1500))
      list().props.onScroll(event(900))
    })
    expect(list().props.maintainScrollAtEnd).toBe(false)
    await act(async () =>
      renderer.update(<MobileNativeChatView {...props({ streaming: 'growing' })} />)
    )
    expect(state.jumps).not.toHaveBeenCalled()
    const jump = renderer.root
      .findAllByType('Pressable')
      .find((node) => node.props.accessibilityLabel === 'Scroll to latest')
    await act(async () => jump?.props.onPress())
    expect(state.jumps).toHaveBeenCalledOnce()
    expect(list().props.maintainScrollAtEnd).toEqual({ animated: false })
    await act(async () => list().props.onMomentumScrollBegin(event(1500)))
    expect(list().props.maintainScrollAtEnd).toBe(false)
  })
  it('cancels an old transcript release frame on switch', async () => {
    vi.stubGlobal('requestAnimationFrame', () => 7)
    const cancel = vi.fn()
    vi.stubGlobal('cancelAnimationFrame', cancel)
    await render()
    await act(async () => {
      list().props.onScrollBeginDrag(event(900))
      list().props.onScrollEndDrag(event(900))
    })
    await act(async () =>
      renderer.update(<MobileNativeChatView {...props({ transcriptIdentity: 'chat-b' })} />)
    )
    expect(cancel).toHaveBeenCalledWith(7)
  })
})
