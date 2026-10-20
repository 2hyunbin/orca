import type { WorktreeDragGroup } from '../../worktree-manual-order'

/**
 * The lane a natively dragged card starts in, read from the card's own row. A same-id twin's card
 * sits in another lane, so searching the lanes by id can pick the twin's and place the drop
 * against the wrong rows; the id search is only for a card outside a sidebar row.
 */
export function nativeDragSourceGroupKey(
  card: Element,
  groups: readonly WorktreeDragGroup[],
  worktreeId: string
): string | null {
  const row = card.closest<HTMLElement>('[data-worktree-drag-group-key]')
  return (
    row?.dataset.worktreeDragGroupKey ??
    groups.find((group) => group.worktreeIds.includes(worktreeId))?.key ??
    null
  )
}
