// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { measureTerminalGroupGridSizes } from './terminal-group-grid-sizes'

type FakePane = { terminal: unknown; container: HTMLElement }
const panes = vi.hoisted((): { list: FakePane[] } => ({ list: [] }))
vi.mock('../mounted-terminal-tab-registry', () => ({
  mountedTerminalTabEntries: () => [
    ['tab-1', { getManager: () => ({ getPanes: () => panes.list }) }]
  ]
}))

function withRect<T extends HTMLElement>(element: T, width: number, height: number): T {
  element.getBoundingClientRect = () => new DOMRect(0, 0, width, height)
  return element
}

/** A pane whose xterm host sits 4px inside it, like `.xterm-container`. */
function pane(opts: { fontSize: number; cellWidth: number; title?: boolean }): FakePane {
  const container = withRect(document.createElement('div'), 500, 400)
  if (opts.title) {
    container.setAttribute('data-has-title', '')
  }
  const host = withRect(document.createElement('div'), 496, 396)
  const element = document.createElement('div')
  host.appendChild(element)
  container.appendChild(host)
  return {
    container,
    terminal: {
      element,
      options: { fontSize: opts.fontSize, scrollback: 1000, scrollbar: undefined },
      dimensions: { css: { cell: { width: opts.cellWidth, height: 16 } } }
    }
  }
}

function groupBody(id: string, width: number, height: number): void {
  const body = withRect(document.createElement('div'), width, height)
  body.dataset.tabGroupBodyId = id
  document.body.appendChild(body)
}

afterEach(() => {
  panes.list = []
  document.body.replaceChildren()
})

describe('measureTerminalGroupGridSizes', () => {
  it('sizes each group from a pane at the default font with no title', () => {
    panes.list = [
      pane({ fontSize: 20, cellWidth: 12 }),
      pane({ fontSize: 14, cellWidth: 10, title: true }),
      pane({ fontSize: 14, cellWidth: 8 })
    ]
    groupBody('group-a', 548, 1004)
    groupBody('group-b', 1100, 500)

    // (548 - 4 inset - 14 scrollbar) / 8 = 66; (1004 - 4) / 16 = 62.
    expect(measureTerminalGroupGridSizes(14)).toEqual({
      'group-a': { cols: 66, rows: 62 },
      'group-b': { cols: 135, rows: 31 }
    })
  })

  it('leaves the sizes out when no pane at the default font is measurable', () => {
    panes.list = [pane({ fontSize: 20, cellWidth: 12 })]
    groupBody('group-a', 548, 1004)

    expect(measureTerminalGroupGridSizes(14)).toBeUndefined()
  })
})
