import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { useActiveWorktreeScroll } from './use-active-worktree-scroll'

type Row = { worktreeId: string; isActive?: boolean }
type Sections = { key: string; data: Row[] }[]

const listOf = (active: string): Sections => [
  {
    key: 'all',
    data: ['a', 'b', 'c'].map((worktreeId) => ({ worktreeId, isActive: worktreeId === active }))
  }
]

function mount(sections: Sections, searching: boolean) {
  const scrollToLocation = vi.fn()
  function Probe(props: { sections: Sections; searching: boolean }): null {
    const { sectionListRef } = useActiveWorktreeScroll(props.sections, props.searching)
    // The hook calls only scrollToLocation on its list.
    Object.assign(sectionListRef, { current: { scrollToLocation } })
    return null
  }
  let renderer: ReactTestRenderer | null = null
  act(() => {
    renderer = create(createElement(Probe, { sections, searching }))
  })
  const update = (next: Sections, nextSearching: boolean) =>
    act(() => {
      renderer?.update(createElement(Probe, { sections: next, searching: nextSearching }))
    })
  return { scrollToLocation, update }
}

describe('useActiveWorktreeScroll', () => {
  it('scrolls to the highlighted row, and again when the highlight moves', () => {
    const list = mount(listOf('b'), false)
    expect(list.scrollToLocation).toHaveBeenLastCalledWith(
      expect.objectContaining({ sectionIndex: 0, itemIndex: 1 })
    )
    list.update(listOf('c'), false)
    expect(list.scrollToLocation).toHaveBeenLastCalledWith(
      expect.objectContaining({ itemIndex: 2 })
    )
  })

  it('never follows a highlight a search moves, nor scrolls back when the search clears', () => {
    const list = mount(listOf('b'), false)
    expect(list.scrollToLocation).toHaveBeenCalledTimes(1)
    // The search hides the phone's row, so the desktop's row takes the highlight.
    list.update(listOf('c'), true)
    expect(list.scrollToLocation).toHaveBeenCalledTimes(1)
    // Cleared: the highlight is back on the row the list already scrolled to.
    list.update(listOf('b'), false)
    expect(list.scrollToLocation).toHaveBeenCalledTimes(1)
  })
})
