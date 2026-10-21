// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { Command } from 'cmdk'
import { useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {})
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function ControlledPalette({
  ids,
  onSelect
}: {
  ids: readonly string[]
  onSelect: (id: string) => void
}) {
  const [selected, setSelected] = useState('third')
  const [previous, setPrevious] = useState(ids)
  if (ids !== previous) {
    setPrevious(ids)
    if (!ids.includes(selected)) {
      const previousIndex = previous.indexOf(selected)
      setSelected(ids[Math.min(previousIndex, ids.length - 1)] ?? '')
    }
  }
  return (
    <Command value={selected} onValueChange={setSelected} shouldFilter={false}>
      <Command.Input />
      <Command.List>
        {ids.map((id) => (
          <Command.Item key={id} value={id} onSelect={onSelect}>
            {id}
          </Command.Item>
        ))}
      </Command.List>
    </Command>
  )
}

it('keeps keyboard and pointer selection working after the selected item disappears', async () => {
  const onSelect = vi.fn()
  const initial = ['first', 'second', 'third', 'fourth', 'fifth']
  const view = render(<ControlledPalette ids={initial} onSelect={onSelect} />)
  const selected = () =>
    view.container.querySelector('[cmdk-item][data-selected="true"]')?.textContent
  expect(selected()).toBe('third')
  view.rerender(
    <ControlledPalette ids={initial.filter((id) => id !== 'third')} onSelect={onSelect} />
  )
  await act(async () => {})
  // Upstream cmdk resets to the first item when the selected item unmounts.
  expect(selected()).toBe('first')
  fireEvent.keyDown(view.container.querySelector('[cmdk-input]')!, { key: 'ArrowDown' })
  expect(selected()).toBe('second')
  fireEvent.pointerMove(view.getByText('fourth'))
  expect(selected()).toBe('fourth')
  fireEvent.keyDown(view.container.querySelector('[cmdk-input]')!, { key: 'Enter' })
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('fourth')
})

it('still selects the first remaining item when an uncontrolled selection disappears', async () => {
  const palette = (ids: readonly string[]) => (
    <Command defaultValue="second" shouldFilter={false}>
      <Command.Input />
      <Command.List>
        {ids.map((id) => (
          <Command.Item key={id} value={id}>
            {id}
          </Command.Item>
        ))}
      </Command.List>
    </Command>
  )
  const view = render(palette(['first', 'second', 'third']))
  view.rerender(palette(['first', 'third']))
  await act(async () => {})
  expect(view.container.querySelector('[cmdk-item][data-selected="true"]')?.textContent).toBe(
    'first'
  )
})
