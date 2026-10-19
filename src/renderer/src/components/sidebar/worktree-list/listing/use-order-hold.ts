import { useState, useSyncExternalStore } from 'react'
import type { SortBy } from '../../../../../../shared/sidebar-list/smart-sort'
import { mergeHeldOrder } from './held-order'

const LIST_SELECTOR = '[data-worktree-sidebar-container]'

let pointerInside = false
let pressedInside = false
let dragging = false
const listeners = new Set<() => void>()

function inList(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(LIST_SELECTOR) !== null
}

function update(next: { inside?: boolean; pressed?: boolean; drag?: boolean }): void {
  const before = isEngaged()
  pointerInside = next.inside ?? pointerInside
  pressedInside = next.pressed ?? pressedInside
  dragging = next.drag ?? dragging
  if (before !== isEngaged()) {
    listeners.forEach((listener) => listener())
  }
}

function isEngaged(): boolean {
  return pointerInside || pressedInside || dragging
}

const DOCUMENT_HANDLERS: [string, (event: Event) => void][] = [
  ['pointerover', (event) => update({ inside: inList(event.target) })],
  [
    'pointerout',
    (event) => {
      if (event instanceof PointerEvent && event.relatedTarget === null) {
        update({ inside: false })
      }
    }
  ],
  ['pointerdown', (event) => update({ pressed: inList(event.target) })],
  ['pointerup', () => update({ pressed: false })],
  ['pointercancel', () => update({ pressed: false })],
  ['dragstart', (event) => update({ drag: inList(event.target) })],
  // Pointer events pause during a drag, so its end also ends the hover hold.
  ['dragend', () => update({ drag: false, inside: false })],
  ['drop', () => update({ drag: false, inside: false })]
]

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    for (const [type, handler] of DOCUMENT_HANDLERS) {
      document.addEventListener(type, handler, true)
    }
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      for (const [type, handler] of DOCUMENT_HANDLERS) {
        document.removeEventListener(type, handler, true)
      }
      pointerInside = pressedInside = dragging = false
    }
  }
}

const notEngaged = (): boolean => false

/**
 * Desktop only, display only: in Recent and Smart, rows stay put under the pointer and during a
 * drag, so a click never lands on a row that just moved; the new order applies on leave or drag end.
 */
export function useOrderHeldWhileEngaged(ids: string[], sortBy: SortBy): string[] {
  // The stamp-sorted list moves on events, so it holds.
  const engaged = useSyncExternalStore(subscribe, isEngaged, notEngaged)
  const [shown, setShown] = useState({ ids, sortBy })
  // Only Recent and Smart move on their own; a mode switch applies at once, like adds and removals.
  const holds = engaged && (sortBy === 'recent' || sortBy === 'smart')
  const next =
    holds && shown.sortBy === sortBy
      ? { ids: mergeHeldOrder(shown.ids, ids), sortBy }
      : { ids, sortBy }
  const changed = next.ids !== shown.ids || next.sortBy !== shown.sortBy
  if (changed) {
    setShown(next)
  }
  return next.ids
}
