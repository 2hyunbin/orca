import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => {
  const icons = [
    'CalendarClock',
    'CircleDot',
    'ExternalLink',
    'GitMerge',
    'GitPullRequest',
    'GitPullRequestClosed',
    'GitPullRequestDraft',
    'SquareTerminal',
    'StickyNote',
    'ChevronRight'
  ]
  return Object.fromEntries(icons.map((name) => [name, name]))
})
vi.mock('../components/TaskProviderLogo', () => ({ TaskProviderLogo: 'TaskProviderLogo' }))
vi.mock('../components/MobileSwitch', () => ({ MobileSwitch: 'MobileSwitch' }))

import {
  WorkspaceDetailsHeader,
  WorkspaceDetailsSection,
  type WorkspaceDetailsSectionProps
} from './workspace-details-section'

let renderer: ReactTestRenderer | null = null

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

function render(props: Partial<WorkspaceDetailsSectionProps>) {
  const onOpenLink = vi.fn()
  act(() => {
    renderer = create(
      createElement(WorkspaceDetailsSection, {
        links: [],
        notes: null,
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
    expect(root.find((node) => String(node.type) === 'TaskProviderLogo').props.provider).toBe(
      'linear'
    )
  })

  it('shows notes as plain text, with no links group when nothing is linked', () => {
    const { root } = render({ notes: 'Check iPad layout' })
    expect(texts(root)).toEqual(['Check iPad layout'])
    expect(root.findAll((node) => node.props.accessibilityRole === 'link')).toEqual([])
  })

  it('says so when a sheet with no actions has nothing to show', () => {
    expect(texts(render({ emptyText: 'No links or notes' }).root)).toEqual(['No links or notes'])
  })

  it('heads the sheet with the workspace, its branch and who created it', () => {
    const header = (origin: Parameters<typeof WorkspaceDetailsHeader>[0]['origin']) => {
      act(() => {
        renderer = create(
          createElement(WorkspaceDetailsHeader, {
            name: 'nightly-deps',
            branch: 'nightly-deps',
            origin
          })
        )
      })
      return renderer!.root
    }
    expect(texts(header({ kind: 'automation', name: 'Nightly dependency bump' }))).toEqual([
      'nightly-deps',
      'nightly-deps',
      'Created by automation \u201cNightly dependency bump\u201d'
    ])
    expect(header({ kind: 'automation' }).findByProps({ testID: 'workspace-origin' })).toBeTruthy()
    expect(texts(header({ kind: 'cli' }))).toEqual([
      'nightly-deps',
      'nightly-deps',
      'Created from Orca CLI'
    ])
    expect(header(null).findAll((node) => node.props.testID === 'workspace-origin')).toEqual([])
  })
})
