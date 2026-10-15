import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

const writeText = vi.fn<(value: string) => Promise<void>>()

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => {
  const icons = [
    'CalendarClock',
    'Check',
    'CircleDot',
    'Copy',
    'ExternalLink',
    'GitMerge',
    'GitPullRequest',
    'GitPullRequestClosed',
    'GitPullRequestDraft',
    'Plug',
    'SquareTerminal',
    'StickyNote',
    'ChevronRight'
  ]
  return Object.fromEntries(icons.map((name) => [name, name]))
})
vi.mock('../components/TaskProviderLogo', () => ({ TaskProviderLogo: 'TaskProviderLogo' }))
vi.mock('../components/MobileSwitch', () => ({ MobileSwitch: 'MobileSwitch' }))
vi.mock('../platform/clipboard', () => ({ useClipboardWriter: () => ({ writeText }) }))

import {
  WorkspaceDetailsSection,
  type WorkspaceDetailsSectionProps
} from './workspace-details-section'

let renderer: ReactTestRenderer | null = null

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  writeText.mockReset()
  vi.useRealTimers()
})

function render(props: Partial<WorkspaceDetailsSectionProps>) {
  const onOpenLink = vi.fn()
  act(() => {
    renderer = create(
      createElement(WorkspaceDetailsSection, {
        links: [],
        origin: null,
        notes: null,
        ports: null,
        onOpenLink,
        ...props
      })
    )
  })
  return { root: renderer!.root, onOpenLink }
}

function texts(node: ReactTestInstance): string[] {
  return node
    .findAll((child) => String(child.type) === 'Text')
    .map((child) =>
      child.children
        .map((part) => (typeof part === 'string' ? part : texts(part).join('')))
        .join('')
    )
}

function pressable(root: ReactTestInstance, label: string): ReactTestInstance {
  return root.find(
    (node) => String(node.type) === 'Pressable' && node.props.accessibilityLabel === label
  )
}

describe('the long-press details section', () => {
  it('draws nothing for a workspace with no details', () => {
    expect(render({}).root.findAll((node) => node.props.testID === 'workspace-details')).toEqual([])
  })

  it('shows a linked PR with its title, state and checks, and opens it on tap', () => {
    const { root, onOpenLink } = render({
      links: [
        {
          key: 'github:pr:12',
          provider: 'github',
          type: 'pr',
          label: 'PR #12',
          title: 'Search keyboard',
          url: 'https://github.com/o/r/pull/12',
          state: 'open',
          checks: 'success'
        }
      ]
    })

    expect(texts(root)).toEqual(['Search keyboard', 'PR #12 · Open · Checks: Passing'])
    act(() => pressable(root, 'Open PR #12, Search keyboard').props.onPress())
    expect(onOpenLink).toHaveBeenCalledWith('https://github.com/o/r/pull/12')
  })

  it('shows a reference with no link as text, not a button', () => {
    const { root } = render({
      links: [{ key: 'linear:issue:ENG-7', provider: 'linear', type: 'issue', label: 'ENG-7' }]
    })

    expect(texts(root)).toEqual(['ENG-7', 'Linear'])
    expect(root.findAll((node) => node.props.accessibilityRole === 'link')).toEqual([])
    expect(root.findByType('TaskProviderLogo' as never).props.provider).toBe('linear')
  })

  it('shows the automation, CLI origin and notes in the desktop order', () => {
    const { root } = render({
      origin: { kind: 'automation', name: 'Nightly deps', runTitle: 'Run 3' },
      notes: 'Check iPad layout'
    })
    expect(texts(root)).toEqual(['Nightly deps', 'Automation · Run 3', 'Check iPad layout'])

    act(() => renderer?.unmount())
    const cli = render({ origin: { kind: 'cli', fromAgent: true, startupAgent: 'Claude' } })
    expect(texts(cli.root)).toEqual([
      'Created by an agent via orca worktree create',
      'orca worktree create',
      'Orca CLI · Started with Claude'
    ])
  })

  it('lists live ports and copies one, saying so until the confirmation fades', async () => {
    vi.useFakeTimers()
    writeText.mockResolvedValue()
    const { root } = render({
      ports: [{ id: 'a', port: 5173, address: 'localhost:5173', processName: 'vite' }]
    })
    expect(texts(root)).toEqual(['Live ports 1', '1', 'localhost:5173', 'vite'])

    await act(async () => {
      pressable(root, 'Copy localhost:5173').props.onPress()
    })
    expect(writeText).toHaveBeenCalledWith('localhost:5173')
    expect(pressable(root, 'Copied localhost:5173')).toBeTruthy()

    act(() => {
      vi.advanceTimersByTime(1500)
    })
    expect(pressable(root, 'Copy localhost:5173')).toBeTruthy()
  })

  it('does not claim a copy the clipboard refused', async () => {
    writeText.mockRejectedValue(new Error('refused'))
    const { root } = render({ ports: [{ id: 'a', port: 3000, address: 'localhost:3000' }] })

    await act(async () => {
      pressable(root, 'Copy localhost:3000').props.onPress()
    })
    expect(pressable(root, 'Copy localhost:3000')).toBeTruthy()
  })

  it('hides ports while unknown, and says what it verified is empty when asked', () => {
    expect(texts(render({ ports: null, emptyText: 'No links or notes' }).root)).toEqual([
      'No links or notes'
    ])
  })
})
