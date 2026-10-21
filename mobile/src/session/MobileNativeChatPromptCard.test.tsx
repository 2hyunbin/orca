import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NATIVE_CHAT_QUESTION_AUTO_ADVANCE_MS } from '../../../src/shared/native-chat-question-auto-advance'
import { MobileNativeChatPromptCard } from './MobileNativeChatPromptCard'

vi.mock('react-native', () => ({
  Keyboard: { dismiss: () => {} },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View',
  Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios }
}))
vi.mock('lucide-react-native', () => ({
  Check: 'Check',
  ArrowUp: 'ArrowUp',
  ChevronDown: 'ChevronDown',
  ChevronUp: 'ChevronUp',
  CircleHelp: 'CircleHelp',
  ShieldQuestion: 'ShieldQuestion',
  X: 'X'
}))
vi.mock('../components/MobileMarkdown', () => ({ MobileMarkdown: 'Markdown' }))

const textInput = (root: ReactTestInstance) =>
  root.find((node) => node.props.placeholder === 'Type your answer')
const ask = { questions: [{ question: 'Pick?', options: [{ label: 'East' }], multiSelect: false }] }

describe('MobileNativeChatPromptCard collapse', () => {
  afterEach(() => vi.useRealTimers())

  it('cancels a pending single-select answer when collapsed and keeps the choice for review', async () => {
    vi.useFakeTimers()
    let tree: ReactTestRenderer
    const onAnswer = vi.fn(async () => true)
    const render = (collapsed: boolean) =>
      createElement(MobileNativeChatPromptCard, {
        ask,
        onAnswerAsk: onAnswer,
        onCollapseAsk: () => tree.update(render(true)),
        collapsedPrompt: collapsed
          ? { title: 'Pick?', expand: () => tree.update(render(false)) }
          : null
      })
    act(() => {
      tree = create(render(false))
    })
    act(() => tree.root.find((node) => node.props.label === 'East').props.onPress())
    act(() => tree.root.findByProps({ accessibilityLabel: 'Collapse' }).props.onPress())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NATIVE_CHAT_QUESTION_AUTO_ADVANCE_MS)
    })
    expect(onAnswer).not.toHaveBeenCalled()

    act(() => tree.root.findByProps({ accessibilityLabel: 'Expand' }).props.onPress())
    expect(tree.root.find((node) => node.props.label === 'East').props.selected).toBe(true)
    const submit = tree.root.find(
      (node) => node.type === 'Pressable' && node.findAllByProps({ children: 'Submit' }).length > 0
    )
    await act(async () => submit.props.onPress())
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith(ask, [{ indices: [0] }])
    act(() => tree.unmount())
  })

  it('preserves long-question selections and a reply draft across collapse without sending', async () => {
    let tree: ReactTestRenderer
    const onAnswer = vi.fn(async () => true)
    const question = {
      question: 'Select release targets',
      options: Array.from({ length: 20 }, (_, index) => `Target ${index + 1}`),
      optionTokens: Array.from({ length: 20 }, (_, index) => String(index + 1)),
      multiSelect: true,
      freeTextToken: 'other'
    }
    const render = (collapsed: boolean) =>
      createElement(MobileNativeChatPromptCard, {
        question,
        onAnswerQuestion: onAnswer,
        onCollapsePrompt: () => tree.update(render(true)),
        collapsedPrompt: collapsed
          ? { title: question.question, expand: () => tree.update(render(false)) }
          : null
      })
    act(() => {
      tree = create(render(false))
    })
    act(() => tree.root.findAllByProps({ accessibilityRole: 'checkbox' })[19]!.props.onPress())
    act(() => tree.root.findByType('TextInput').props.onChangeText('mobile parity'))
    act(() => tree.root.findByProps({ accessibilityLabel: 'Collapse' }).props.onPress())
    expect(onAnswer).not.toHaveBeenCalled()

    act(() => tree.root.findByProps({ accessibilityLabel: 'Expand' }).props.onPress())
    expect(
      tree.root.findAllByProps({ accessibilityRole: 'checkbox' })[19]!.props.accessibilityState
    ).toEqual({ checked: true })
    expect(tree.root.findByType('TextInput').props.value).toBe('mobile parity')
    await act(async () =>
      tree.root.findByProps({ accessibilityLabel: 'Submit selected options' }).props.onPress()
    )
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith('20, other:mobile%20parity')
    act(() => tree.unmount())
  })

  it('sends no approval response while collapsing and expanding long permission context', async () => {
    let tree: ReactTestRenderer
    const onRespond = vi.fn(async () => true)
    const permission = {
      title: 'Approve release?',
      description: 'Release context '.repeat(400),
      options: [
        { label: 'Allow', send: 'allow' },
        { label: 'Deny', send: 'deny' }
      ]
    }
    const render = (collapsed: boolean) =>
      createElement(MobileNativeChatPromptCard, {
        permission,
        onRespondPermission: onRespond,
        onCollapsePrompt: () => tree.update(render(true)),
        collapsedPrompt: collapsed
          ? { title: permission.title, expand: () => tree.update(render(false)) }
          : null
      })
    act(() => {
      tree = create(render(false))
    })
    act(() => tree.root.findByProps({ accessibilityLabel: 'Collapse' }).props.onPress())
    act(() => tree.root.findByProps({ accessibilityLabel: 'Expand' }).props.onPress())
    expect(onRespond).not.toHaveBeenCalled()
    expect(
      tree.root
        .findByProps({ testID: 'native-chat-approval-content' })
        .findByProps({ children: permission.description })
    ).toBeTruthy()
    const deny = tree.root.find(
      (node) => node.type === 'Pressable' && node.findAllByProps({ children: 'Deny' }).length > 0
    )
    await act(async () => deny.props.onPress())
    expect(onRespond).toHaveBeenCalledExactlyOnceWith('deny')
    act(() => tree.unmount())
  })

  it('keeps a partly answered Ask mounted but hidden while collapsed', async () => {
    let tree: ReactTestRenderer | null = null
    const render = (collapsed: boolean) =>
      createElement(MobileNativeChatPromptCard, {
        ask,
        collapsedPrompt: collapsed ? { title: 'Pick?', expand: () => {} } : null
      })
    await act(async () => {
      tree = create(render(false))
    })
    const other = tree!.root.findAll((node) => node.props.label === 'Other…')[0]!
    act(() => other.props.onPress())
    act(() => textInput(tree!.root).props.onChangeText('turbo'))

    await act(async () => tree!.update(render(true)))
    expect(tree!.root.findByProps({ testID: 'native-chat-prompt-strip' })).toBeTruthy()
    const hidden = tree!.root.findAll((node) => node.props.style?.display === 'none')
    expect(hidden).toHaveLength(1)
    expect(textInput(hidden[0]!).props.value).toBe('turbo')

    await act(async () => tree!.update(render(false)))
    expect(textInput(tree!.root).props.value).toBe('turbo')
    act(() => tree!.unmount())
  })
})
