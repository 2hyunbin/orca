import { describe, expect, it } from 'vitest'
import type { TabGroupLayoutNode } from '../../shared/tab-types'
import { unshownWorkspaceGridSize } from './unshown-workspace-grid-size'

const single = { cols: 239, rows: 80 }
const leaf = (groupId: string): TabGroupLayoutNode => ({ type: 'leaf', groupId })
const split = (
  direction: 'horizontal' | 'vertical',
  first: TabGroupLayoutNode,
  second: TabGroupLayoutNode
): TabGroupLayoutNode => ({ type: 'split', direction, first, second, ratio: 0.8 })

describe('unshownWorkspaceGridSize', () => {
  it('uses the single-group grid for a workspace with at most one group', () => {
    expect(unshownWorkspaceGridSize(single, 0, undefined)).toEqual(single)
    expect(unshownWorkspaceGridSize(single, 1, leaf('a'))).toEqual(single)
  })

  it('divides the columns among groups side by side, ignoring the ratio', () => {
    expect(unshownWorkspaceGridSize(single, 2, split('horizontal', leaf('a'), leaf('b')))).toEqual({
      cols: 119,
      rows: 40
    })
  })

  it('divides the rows among stacked groups', () => {
    expect(
      unshownWorkspaceGridSize(
        single,
        3,
        split('vertical', leaf('a'), split('vertical', leaf('b'), leaf('c')))
      )
    ).toEqual({
      cols: 120,
      rows: 26
    })
  })

  it('follows only the root split for nested splits', () => {
    const nested = split('horizontal', leaf('a'), split('vertical', leaf('b'), leaf('c')))
    expect(unshownWorkspaceGridSize(single, 3, nested)).toEqual({ cols: 79, rows: 40 })
  })

  it('never guesses wider or taller than the unmeasured 120x40', () => {
    const wide = { cols: 400, rows: 200 }
    expect(unshownWorkspaceGridSize(wide, 2, split('horizontal', leaf('a'), leaf('b')))).toEqual({
      cols: 120,
      rows: 40
    })
    expect(unshownWorkspaceGridSize(wide, 2, split('vertical', leaf('a'), leaf('b')))).toEqual({
      cols: 120,
      rows: 40
    })
  })

  it('has no guess without a published single-group grid or a saved split', () => {
    expect(
      unshownWorkspaceGridSize(undefined, 2, split('horizontal', leaf('a'), leaf('b')))
    ).toBeUndefined()
    expect(unshownWorkspaceGridSize(single, 2, undefined)).toBeUndefined()
  })
})
