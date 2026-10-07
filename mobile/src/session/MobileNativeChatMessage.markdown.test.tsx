import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { colors } from '../theme/mobile-theme'

const platform = vi.hoisted(() => ({ os: 'ios' }))
const { writeText, openExternalLink } = vi.hoisted(() => ({
  writeText: vi.fn(),
  openExternalLink: vi.fn()
}))
vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return platform.os
    }
  },
  UIManager: { hasViewManagerConfig: () => true },
  Alert: { alert: vi.fn() },
  Image: 'Image',
  Modal: 'Modal',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  Text: 'Text',
  View: 'View',
  StyleSheet: {
    create: (styles: unknown) => styles,
    flatten: (style: unknown) =>
      Array.isArray(style) ? Object.assign({}, ...style.flat(Infinity).filter(Boolean)) : style,
    hairlineWidth: 1
  }
}))
vi.mock('react-native/Libraries/Utilities/codegenNativeComponent', () => ({
  default: (name: string) => name
}))
vi.mock('react-native-uitextview', () => import('react-native-uitextview/src/Text'))
vi.mock(
  '../components/MobileSelectableText',
  () => import('../components/MobileSelectableText.ios')
)
vi.mock('../components/pr-sidebar/MermaidDiagram', () => ({ MermaidDiagram: 'MermaidDiagram' }))
vi.mock('../platform/external-link', () => ({ openExternalLink }))
vi.mock('../platform/clipboard', () => ({ useClipboardWriter: () => ({ writeText }) }))
vi.mock('../components/mounted-bottom-drawer', () => ({ MountedBottomDrawer: 'MountedDrawer' }))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 16, left: 0, right: 0 })
}))
vi.mock('lucide-react-native', () => ({ Copy: 'Copy', TextSelect: 'TextSelect', X: 'X' }))
vi.mock('./MobileNativeChatToolRun', () => ({ ToolRun: 'ToolRun' }))
vi.mock('./MobileNativeChatReasoningRow', () => ({ MobileNativeChatReasoningRow: 'ReasoningRow' }))
vi.mock('./MobileNativeChatTurnStatus', () => ({ MobileNativeChatTurnStatus: 'TurnStatus' }))

const source = [
  '# Heading',
  '',
  'Prompt with **bold**, [web](https://example.com) and [file](src/main.ts).',
  '',
  '> Quoted words',
  '',
  '- List item',
  '',
  '```ts',
  'const value = 1',
  '```',
  '',
  '| Header |',
  '| --- |',
  '| Cell |'
].join('\n')
const message: NativeChatMessage = {
  id: 'personal-prompt',
  role: 'user',
  blocks: [
    { type: 'text', text: source },
    { type: 'image-ref', url: 'file:///image.png', alt: 'attachment' }
  ],
  timestamp: null,
  source: 'transcript'
}

function textIn(node: ReactTestInstance): string {
  if (typeof node.props.text === 'string') {
    return node.props.text
  }
  return node.children.map((child) => (typeof child === 'string' ? child : textIn(child))).join('')
}

function styleOf(node: ReactTestInstance): Record<string, unknown> {
  const style = node.props.style
  return Array.isArray(style) ? Object.assign({}, ...style.flat(Infinity).filter(Boolean)) : style
}

describe.each(['ios', 'android'])('personal Markdown on %s', (os) => {
  let renderer: ReactTestRenderer | undefined
  const nodes = (type: string) => renderer!.root.findAll((node) => node.type === type)
  const spans = () => nodes(os === 'ios' ? 'RNUITextViewChild' : 'Text')
  const span = (text: string) => spans().find((node) => textIn(node) === text)!
  const onOpenFile = vi.fn()

  beforeEach(() => {
    platform.os = os
    vi.resetModules()
    vi.clearAllMocks()
    writeText.mockResolvedValue(undefined)
  })
  afterEach(() => act(() => renderer?.unmount()))

  async function render(value = message, fontScale = 1) {
    const { MobileNativeChatMessage } = await import('./MobileNativeChatMessage')
    act(() => {
      renderer = create(
        createElement(MobileNativeChatMessage, { message: value, fontScale, onOpenFile })
      )
    })
    return MobileNativeChatMessage
  }

  it('renders Markdown blocks and inline spans while keeping attachments', async () => {
    await render()
    expect(span('bold')).toBeDefined()
    expect(styleOf(span('bold'))).toEqual(
      expect.objectContaining({ fontWeight: os === 'ios' ? 'bold' : '700' })
    )
    for (const text of [
      'Heading',
      'Quoted words',
      'List item',
      'const value = 1',
      'Header',
      'Cell'
    ]) {
      expect(span(text)).toBeDefined()
    }
    expect(spans().some((node) => textIn(node).includes('**bold**'))).toBe(false)
    expect(nodes('Image')[0]!.props.source).toEqual({ uri: 'file:///image.png' })
    if (os === 'ios') {
      const roots = nodes('RNUITextView')
      expect(roots.length).toBeGreaterThan(5)
      expect(roots.every((node) => node.props.selectable === true)).toBe(true)
      expect(nodes('MountedDrawer')).toHaveLength(0)
    } else {
      expect(nodes('Text').some((node) => node.props.selectable === true)).toBe(false)
    }
  })

  it('keeps the bubble foreground, link underline and web/file actions', async () => {
    await render()
    for (const label of ['bold', 'Quoted words', 'web', 'file']) {
      expect(styleOf(span(label)).color).toBe(colors.textPrimary)
    }
    for (const label of ['web', 'file']) {
      expect(styleOf(span(label)).textDecorationLine).toBe('underline')
    }
    act(() => span('web').props.onPress())
    act(() => span('file').props.onPress())
    expect(openExternalLink).toHaveBeenCalledExactlyOnceWith('https://example.com')
    expect(onOpenFile).toHaveBeenCalledExactlyOnceWith('src/main.ts')
  })

  it('retains the ordinary Markdown palette for assistant messages', async () => {
    await render({ ...message, role: 'assistant' })
    expect(styleOf(span('Quoted words')).color).toBe(colors.textSecondary)
    expect(styleOf(span('web')).color).toBe(colors.accentBlue)
  })

  it('keeps user Mermaid fences as native code and assistant diagrams unchanged', async () => {
    const mermaid: NativeChatMessage = {
      ...message,
      blocks: [{ type: 'text', text: '```mermaid\ngraph TD; A-->B\n```' }]
    }
    const component = await render(mermaid)
    expect(span('graph TD; A-->B')).toBeDefined()
    expect(nodes('MermaidDiagram')).toHaveLength(0)
    if (os === 'ios') {
      expect(nodes('RNUITextView')[0]!.props.selectable).toBe(true)
    } else {
      expect(span('graph TD; A-->B').props.selectable).toBe(false)
      act(() =>
        nodes('Pressable')
          .find((node) => node.props.onLongPress)!
          .props.onLongPress()
      )
      expect(nodes('MountedDrawer')).toHaveLength(1)
    }
    act(() =>
      renderer!.update(
        createElement(component, {
          message: { ...mermaid, role: 'assistant' },
          onOpenFile
        })
      )
    )
    expect(nodes('MermaidDiagram')).toHaveLength(1)
    expect(nodes('MermaidDiagram')[0]!.props.source).toBe('graph TD; A-->B')
  })

  it('scales prose without remounting its selection root', async () => {
    const component = await render({ ...message, blocks: [{ type: 'text', text: 'Prose zoom' }] })
    const root = os === 'ios' ? nodes('RNUITextView')[0]! : span('Prose zoom')
    const initial = styleOf(span('Prose zoom'))
    act(() =>
      renderer!.update(
        createElement(component, {
          message: { ...message, blocks: [{ type: 'text', text: 'Prose zoom' }] },
          fontScale: 1.5,
          onOpenFile
        })
      )
    )
    expect(os === 'ios' ? nodes('RNUITextView')[0] : span('Prose zoom')).toBe(root)
    const next = styleOf(span('Prose zoom'))
    expect(next.fontSize).toBe(Number(initial.fontSize) * 1.5)
    expect(next.lineHeight).toBe(Number(initial.lineHeight) * 1.5)
  })

  if (os === 'android') {
    it.each(['row', 'web', 'file'])(
      'opens actions from %s long press and copies the original Markdown',
      async (target) => {
        await render()
        const row = nodes('Pressable').find((node) => node.props.onLongPress)!
        const trigger = target === 'row' ? row : span(target)
        expect(trigger.props.onLongPress).toBe(row.props.onLongPress)
        act(() => trigger.props.onLongPress())
        expect(nodes('MountedDrawer')).toHaveLength(1)
        const copy = nodes('Pressable').find((node) =>
          node.children.some(
            (child) => typeof child !== 'string' && textIn(child) === 'Copy message'
          )
        )!
        act(() => copy.props.onPress())
        expect(writeText).toHaveBeenCalledExactlyOnceWith(source)
        expect(nodes('MountedDrawer')[0]!.props.visible).toBe(false)
        act(() => nodes('MountedDrawer')[0]!.props.onHidden())
        expect(nodes('MountedDrawer')).toHaveLength(0)
      }
    )
  }
})
