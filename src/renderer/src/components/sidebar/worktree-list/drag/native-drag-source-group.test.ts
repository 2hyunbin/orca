// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { nativeDragSourceGroupKey } from './native-drag-source-group'

const ID = 'repo1::/shared'
// A local and an SSH copy share the id, in different lanes.
const GROUPS = [
  { key: 'status:todo', worktreeIds: [ID] },
  { key: 'status:done', worktreeIds: [ID] }
]

function cardInRow(groupKey: string | null): HTMLElement {
  const row = document.createElement('div')
  if (groupKey) {
    row.dataset.worktreeDragGroupKey = groupKey
  }
  const card = document.createElement('div')
  row.append(card)
  return card
}

describe('nativeDragSourceGroupKey', () => {
  it("reads the dragged card's own lane, not its same-id twin's", () => {
    expect(nativeDragSourceGroupKey(cardInRow('status:done'), GROUPS, ID)).toBe('status:done')
  })

  it('falls back to the id search only for a card outside a sidebar row', () => {
    expect(nativeDragSourceGroupKey(cardInRow(null), GROUPS, ID)).toBe('status:todo')
  })
})
