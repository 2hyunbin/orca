import { createElement } from 'react'
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileAgentIcon } from './MobileAgentIcon'

vi.mock('react-native', () => ({
  Image: 'Image',
  StyleSheet: { create: (styles: unknown) => styles },
  Text: 'Text',
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({
  Terminal: 'Terminal'
}))

vi.mock('react-native-svg', () => ({
  default: 'Svg',
  Defs: 'Defs',
  G: 'G',
  LinearGradient: 'LinearGradient',
  Path: 'Path',
  Stop: 'Stop'
}))

vi.mock('./mobile-agent-icon-assets', () => ({
  MOBILE_AGENT_ICON_ASSETS: { dsh: 'dsh-whale-asset', cursor: 'cursor-asset' }
}))

vi.mock('./AgentIcons', () => ({
  ClaudeIcon: 'ClaudeIcon',
  OpenAIIcon: 'OpenAIIcon'
}))

function hostType(node: ReactTestInstance): unknown {
  return node.type
}

describe('MobileAgentIcon DeepSeek Build', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.restoreAllMocks()
  })

  it('renders the bundled whale for DeepSeek Build like DeepSeek Harness', async () => {
    await act(async () => {
      renderer = create(createElement(MobileAgentIcon, { agentId: 'dsb', size: 20 }))
    })
    if (!renderer) {
      throw new Error('Icon renderer did not mount')
    }
    const image = renderer.root.find((node) => hostType(node) === 'Image')
    const source = image.props.source
    expect(source).toBe('dsh-whale-asset')
    expect(image.props.style).toMatchObject({ width: 20, height: 20 })
    await act(async () => {
      renderer?.update(createElement(MobileAgentIcon, { agentId: 'dsh', size: 20 }))
    })
    expect(renderer.root.find((node) => hostType(node) === 'Image').props.source).toBe(source)
  })
})
