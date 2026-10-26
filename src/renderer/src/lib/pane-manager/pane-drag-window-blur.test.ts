// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPaneInternal } from './pane-manager-types'
import { attachPaneDrag } from './pane-drag-pointer'
import { createDragReorderState } from './pane-drag-reorder'
import { attachDividerDrag } from './pane-divider-drag'

function pointer(type: string, init: { clientX?: number; clientY?: number } = {}): Event {
  return Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
    button: 0,
    ctrlKey: false,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0
  })
}

function capturable(element: HTMLElement): HTMLElement {
  const captured = new Set<number>()
  element.setPointerCapture = (id) => void captured.add(id)
  element.releasePointerCapture = (id) => void captured.delete(id)
  element.hasPointerCapture = (id) => captured.has(id)
  return element
}

function paneWithInput(): { container: HTMLElement; input: HTMLTextAreaElement } {
  const container = document.createElement('div')
  container.className = 'pane'
  const input = document.createElement('textarea')
  container.appendChild(input)
  return { container, input }
}

afterEach(() => {
  document.body.replaceChildren()
})

// A host snapshot or late terminal attach can move focus between panes mid-gesture; only the
// window losing focus may end it.
describe('pane gestures and focus changes', () => {
  it('a pane drag survives focus moving to another pane and ends when the window blurs', () => {
    const root = document.createElement('div')
    const source = paneWithInput()
    const other = paneWithInput()
    root.append(source.container, other.container)
    document.body.appendChild(root)
    const handle = capturable(document.createElement('div'))
    source.container.appendChild(handle)
    const panes = new Map([
      [1, { id: 1, container: source.container }],
      [2, { id: 2, container: other.container }]
    ])
    const state = createDragReorderState()
    attachPaneDrag(handle, 1, state, {
      // SAFETY: the drag reads only `id` and `container` from a pane.
      getPanes: () => panes as unknown as Map<number, ManagedPaneInternal>,
      getRoot: () => root,
      getStyleOptions: () => ({}),
      isDestroyed: () => false,
      safeFit: vi.fn(),
      applyPaneOpacity: vi.fn(),
      applyDividerStyles: vi.fn(),
      refitPanesUnder: vi.fn()
    })
    source.input.focus()

    handle.dispatchEvent(pointer('pointerdown'))
    handle.dispatchEvent(pointer('pointermove', { clientY: 20 }))
    expect(state.dragSourcePaneId).toBe(1)

    other.input.focus()
    expect(state.dragSourcePaneId).toBe(1)
    expect(root.classList.contains('is-pane-dragging')).toBe(true)

    window.dispatchEvent(new Event('blur'))
    expect(state.dragSourcePaneId).toBeNull()
    expect(root.classList.contains('is-pane-dragging')).toBe(false)
  })

  it('a divider drag survives focus moving to another pane and ends when the window blurs', () => {
    const split = document.createElement('div')
    const before = paneWithInput()
    const after = paneWithInput()
    const divider = capturable(document.createElement('div'))
    split.append(before.container, divider, after.container)
    document.body.appendChild(split)
    for (const pane of [before.container, after.container]) {
      pane.getBoundingClientRect = () => DOMRect.fromRect({ width: 200, height: 100 })
    }
    attachDividerDrag(divider, true, { refitPanesUnder: vi.fn() })
    before.input.focus()

    divider.dispatchEvent(pointer('pointerdown', { clientX: 200 }))
    expect(divider.classList.contains('is-dragging')).toBe(true)

    after.input.focus()
    expect(divider.classList.contains('is-dragging')).toBe(true)

    window.dispatchEvent(new Event('blur'))
    expect(divider.classList.contains('is-dragging')).toBe(false)
  })
})
