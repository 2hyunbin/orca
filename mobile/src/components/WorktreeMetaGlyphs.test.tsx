import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({
  CalendarClock: 'CalendarClock',
  CircleDot: 'CircleDot',
  GitMerge: 'GitMerge',
  SquareTerminal: 'SquareTerminal',
  StickyNote: 'StickyNote'
}))
vi.mock('./TaskProviderLogo', () => ({ TaskProviderLogo: 'TaskProviderLogo' }))

import { WorktreeMetaGlyphs } from './WorktreeMetaGlyphs'

let renderer: ReactTestRenderer | null = null

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

function glyphs(props: Parameters<typeof WorktreeMetaGlyphs>[0]): string[] {
  act(() => {
    renderer = create(createElement(WorktreeMetaGlyphs, props))
  })
  return renderer!.root
    .findAll((node) => typeof node.type === 'string' && String(node.type) !== 'View')
    .map((node) =>
      String(node.type) === 'TaskProviderLogo'
        ? `logo:${String(node.props.provider)}`
        : String(node.type)
    )
}

describe('WorktreeMetaGlyphs', () => {
  it('draws the automation, CLI and Jira glyphs in the desktop order', () => {
    expect(
      glyphs({
        comment: 'note',
        automationCreated: true,
        cliCreated: true,
        linkedIssue: 3,
        linkedJiraIssue: true,
        linkedLinearIssue: 'ENG-1'
      })
    ).toEqual(['StickyNote', 'CalendarClock', 'SquareTerminal', 'CircleDot', 'logo:jira', 'Text'])
  })

  it('draws nothing when the row has none of them', () => {
    act(() => {
      renderer = create(createElement(WorktreeMetaGlyphs, {}))
    })
    expect(renderer!.toJSON()).toBeNull()
  })
})
