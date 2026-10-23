// @vitest-environment happy-dom

import React, { type ComponentProps } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { NativeChatQueuedMessageRows } from './NativeChatQueuedMessageRows'
import type { QueuedMessageCard } from './structured-agent-session-queued-cards'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/components/ui/button', () => ({
  Button: React.forwardRef<
    HTMLButtonElement,
    ComponentProps<'button'> & { variant?: string; size?: string }
  >(({ variant: _variant, size: _size, ...props }, ref) => <button ref={ref} {...props} />)
}))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => children,
  TooltipTrigger: ({ children }: React.PropsWithChildren) => children,
  TooltipContent: () => null
}))

it('keeps actual sortable metadata stable across unchanged visible and collapsed publications at N and 10N', () => {
  for (const count of [100, 1000]) {
    const originalIndexOf = Array.prototype.indexOf
    const originalSlice = Array.prototype.slice
    let scans = 0
    let copies = 0
    const tracked = (values: unknown[]): boolean =>
      values.length === count &&
      typeof values[0] === 'string' &&
      values[0].startsWith('sortable-contract-')
    const indexOf = vi.spyOn(Array.prototype, 'indexOf').mockImplementation(function (
      this: unknown[],
      search: unknown,
      from?: number
    ) {
      const index = originalIndexOf.call(this, search, from)
      if (tracked(this)) {
        scans += index < 0 ? this.length : index + 1
      }
      return index
    })
    const slice = vi.spyOn(Array.prototype, 'slice').mockImplementation(function (
      this: unknown[],
      start?: number,
      end?: number
    ) {
      const result = originalSlice.call(this, start, end)
      if (tracked(this)) {
        copies += result.length
      }
      return result
    })
    try {
      const cards: QueuedMessageCard[] = Array.from({ length: count }, (_, position) => ({
        messageId: `sortable-contract-${position}`,
        position,
        text: 'queued',
        state: 'waiting',
        hold: 'queue-paused'
      }))
      const move = vi.fn(async () => {})
      const action = vi.fn()
      const reorder = { scope: 'contract', pending: false, move }
      const row: ComponentProps<typeof NativeChatQueuedMessageRows>['renderCard'] = (
        card,
        drag
      ) => (
        <li
          key={card.messageId}
          ref={drag?.rowRef}
          style={drag?.rowStyle}
          onClick={() => action(card.text)}
        >
          {card.text}
          {drag?.grip}
        </li>
      )
      const mounted = render(
        <ul>
          <NativeChatQueuedMessageRows cards={cards} reorder={reorder} renderCard={row} />
        </ul>
      )
      // The real installed library's cold suffix construction is the instrumentation control.
      expect(copies).toBeGreaterThanOrEqual((count * (count + 1)) / 2)
      scans = copies = 0
      mounted.rerender(
        <ul>
          <NativeChatQueuedMessageRows cards={cards} reorder={reorder} renderCard={row} />
        </ul>
      )
      expect({ scans, copies }).toEqual({ scans: 0, copies: 0 })
      mounted.rerender(
        <ul hidden>
          <NativeChatQueuedMessageRows
            cards={cards}
            reorder={{ ...reorder }}
            renderCard={(card, drag) => row({ ...card, text: 'latest' }, drag)}
          />
        </ul>
      )
      expect({ scans, copies }).toEqual({ scans: 0, copies: 0 })
      expect(mounted.container.querySelector('li')?.textContent).toBe('latest')
      const latestRow = mounted.container.querySelector('li')
      if (!latestRow) {
        throw new Error('missing queued row')
      }
      fireEvent.click(latestRow)
      expect(action).toHaveBeenLastCalledWith('latest')
      const changed = cards.map((card) => ({ ...card, text: 'changed' }))
      mounted.rerender(
        <ul hidden>
          <NativeChatQueuedMessageRows cards={changed} reorder={reorder} renderCard={row} />
        </ul>
      )
      expect(copies).toBe(0)
      expect(mounted.container.querySelector('li')?.textContent).toBe('changed')
      const reversed = changed.toReversed()
      mounted.rerender(
        <ul>
          <NativeChatQueuedMessageRows cards={reversed} reorder={reorder} renderCard={row} />
        </ul>
      )
      const grip = mounted.container.querySelector('button')
      expect(grip).not.toBeNull()
      if (!grip) {
        throw new Error('missing reorder grip')
      }
      fireEvent.keyDown(grip, { key: 'ArrowDown' })
      expect(move).toHaveBeenLastCalledWith(reversed[0].messageId, {
        afterMessageId: reversed[1].messageId
      })
      const latestMove = vi.fn(async () => {})
      mounted.rerender(
        <ul>
          <NativeChatQueuedMessageRows
            cards={reversed}
            reorder={{ ...reorder, move: latestMove }}
            renderCard={row}
          />
        </ul>
      )
      fireEvent.keyDown(grip, { key: 'ArrowDown' })
      expect(latestMove).toHaveBeenLastCalledWith(reversed[0].messageId, {
        afterMessageId: reversed[1].messageId
      })
      mounted.rerender(
        <ul>
          <NativeChatQueuedMessageRows
            cards={reversed}
            reorder={{ ...reorder, pending: true }}
            renderCard={row}
          />
        </ul>
      )
      fireEvent.keyDown(grip, { key: 'ArrowDown' })
      expect(move).toHaveBeenCalledTimes(1)
      expect(latestMove).toHaveBeenCalledTimes(1)
      const extra = { ...reversed[0], messageId: 'new-member' }
      mounted.rerender(
        <ul>
          <NativeChatQueuedMessageRows
            cards={[extra, ...reversed]}
            reorder={reorder}
            renderCard={row}
          />
        </ul>
      )
      expect(mounted.container.querySelectorAll('li')).toHaveLength(count + 1)
      const newGrip = mounted.container.querySelector('button')
      if (!newGrip) {
        throw new Error('missing new member grip')
      }
      fireEvent.keyDown(newGrip, { key: 'ArrowDown' })
      expect(move).toHaveBeenLastCalledWith(extra.messageId, {
        afterMessageId: reversed[0].messageId
      })
      mounted.unmount()
    } finally {
      indexOf.mockRestore()
      slice.mockRestore()
      cleanup()
    }
  }
})
