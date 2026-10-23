import { describe, expect, it } from 'vitest'
import { tabOrderMoves } from './tab-order'

/** Main's same-group moveTab: take the tab out, put it back at the index. */
function replay(from: string[], moves: ReturnType<typeof tabOrderMoves>): string[] {
  let order = [...from]
  for (const { tabId, index } of moves) {
    order = order.filter((id) => id !== tabId)
    order.splice(index, 0, tabId)
  }
  return order
}

describe('tabOrderMoves', () => {
  it('is one move when one tab moved, either way', () => {
    expect(tabOrderMoves(['a', 'b', 'c', 'd'], ['b', 'c', 'a', 'd'])).toEqual([
      { tabId: 'a', index: 2 }
    ])
    expect(tabOrderMoves(['a', 'b', 'c', 'd'], ['a', 'd', 'b', 'c'])).toEqual([
      { tabId: 'd', index: 1 }
    ])
  })

  it('replays any permutation to the same order', () => {
    const from = ['a', 'b', 'c', 'd', 'e']
    for (const to of [
      ['e', 'd', 'c', 'b', 'a'],
      ['b', 'a', 'd', 'c', 'e'],
      ['c', 'e', 'a', 'b', 'd']
    ]) {
      expect(replay(from, tabOrderMoves(from, to))).toEqual(to)
    }
  })

  it('detects a late adjacent swap without rescanning the order for every tab', () => {
    const from = Array.from({ length: 128 }, (_, index) => `tab-${index}`)
    const to = [...from]
    to.splice(125, 2, 'tab-126', 'tab-125')
    let reads = 0
    Object.defineProperty(from, 0, {
      get() {
        reads++
        return 'tab-0'
      }
    })

    expect(tabOrderMoves(from, to)).toEqual([{ tabId: 'tab-126', index: 125 }])
    expect(reads).toBeLessThan(10)
  })

  it('is nothing for the same order or orders holding different tabs', () => {
    expect(tabOrderMoves(['a', 'b'], ['a', 'b'])).toEqual([])
    expect(tabOrderMoves(['a', 'b'], ['b', 'c'])).toEqual([])
    expect(tabOrderMoves(['a', 'b'], ['b'])).toEqual([])
    expect(tabOrderMoves(['a', 'a', 'b'], ['b', 'a', 'a'])).toEqual([])
  })
})
