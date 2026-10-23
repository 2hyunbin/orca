// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ReactNode } from 'react'
import { NativeChatViewIdentity } from './native-chat-view-state-memory'
import { useNativeChatRecallPosition } from './use-native-chat-composer-recall'

describe('useNativeChatRecallPosition', () => {
  it('keeps the shown recall cursor across a detached composer and ends it after an edit', () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <NativeChatViewIdentity.Provider value="recall-return">
        {children}
      </NativeChatViewIdentity.Provider>
    )
    const first = renderHook(({ draft }) => useNativeChatRecallPosition(draft), {
      wrapper,
      initialProps: { draft: '' }
    })
    const recalled = { id: 'second', recalled: 'second prompt' }
    act(() => first.result.current[1](recalled))
    first.rerender({ draft: recalled.recalled })
    first.unmount()
    const returned = renderHook(({ draft }) => useNativeChatRecallPosition(draft), {
      wrapper,
      initialProps: { draft: recalled.recalled }
    })
    expect(returned.result.current[0]).toEqual(recalled)
    returned.rerender({ draft: 'edited second prompt' })
    expect(returned.result.current[0]).toBeNull()
  })

  it('ends recall once the composer stops holding the recalled prompt', () => {
    const { result, rerender } = renderHook(({ draft }) => useNativeChatRecallPosition(draft), {
      initialProps: { draft: '' }
    })
    const recalled = { id: 'sent-1', recalled: 'fix it' }

    // The position can commit a render ahead of its draft; that is not a mismatch.
    act(() => result.current[1](recalled))
    expect(result.current[0]).toBe(recalled)
    rerender({ draft: 'fix it' })
    expect(result.current[0]).toBe(recalled)

    // Sent: the composer empties, so the same text arriving later is not a recall.
    rerender({ draft: '' })
    expect(result.current[0]).toBeNull()
    rerender({ draft: 'fix it' })
    expect(result.current[0]).toBeNull()
  })
})
