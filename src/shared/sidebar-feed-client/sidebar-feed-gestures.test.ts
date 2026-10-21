import { describe, expect, it } from 'vitest'
import {
  emptySidebarFeedGestures,
  requestSidebarFeedGesture,
  sidebarFeedGestureAcknowledged,
  sidebarFeedGestureRefused,
  sidebarFeedGestureValue,
  sidebarFeedGesturesInstalled
} from './sidebar-feed-gestures'

const at = (revision: number, generation = 'g1') => ({ generation, revision })

function collapse(...values: boolean[]) {
  let gestures = emptySidebarFeedGestures<boolean>()
  const ids: number[] = []
  for (const value of values) {
    const requested = requestSidebarFeedGesture(gestures, 'repo:r', value)
    gestures = requested.gestures
    ids.push(requested.gestureId)
  }
  return { gestures, ids }
}

describe('sidebar feed gestures', () => {
  it('keeps the second of a rapid double toggle until its own acknowledgment installs', () => {
    const { gestures: requested, ids } = collapse(true, false)
    expect(sidebarFeedGestureValue(requested, 'repo:r')).toEqual({ value: false })

    let gestures = sidebarFeedGestureAcknowledged(requested, ids[0]!, at(5), at(4))
    // The first write's revision shows `true`, the very value the first gesture drew, yet the
    // second gesture is still in flight: the list keeps drawing `false`.
    gestures = sidebarFeedGesturesInstalled(gestures, at(5))
    expect(gestures.entries.map((entry) => entry.gestureId)).toEqual([ids[1]])
    expect(sidebarFeedGestureValue(gestures, 'repo:r')).toEqual({ value: false })

    gestures = sidebarFeedGestureAcknowledged(gestures, ids[1]!, at(6), at(5))
    expect(sidebarFeedGestureValue(gestures, 'repo:r')).toEqual({ value: false })
    gestures = sidebarFeedGesturesInstalled(gestures, at(6))
    expect(sidebarFeedGestureValue(gestures, 'repo:r')).toBeNull()
  })

  it('is not retired by another device writing the same value', () => {
    const { gestures: requested } = collapse(true)
    // Another device's write installs first and shows `true`: no acknowledgment, no retirement.
    const gestures = sidebarFeedGesturesInstalled(requested, at(9))
    expect(gestures).toBe(requested)
    expect(sidebarFeedGestureValue(gestures, 'repo:r')).toEqual({ value: true })
  })

  it('retires an acknowledgment the install already covers at once', () => {
    const { gestures: requested, ids } = collapse(true)
    const gestures = sidebarFeedGestureAcknowledged(requested, ids[0]!, at(3), at(4))
    expect(gestures.entries).toEqual([])
  })

  it('drops a refused gesture at once', () => {
    const { gestures: requested, ids } = collapse(true, false)
    const gestures = sidebarFeedGestureRefused(requested, ids[1]!)
    expect(sidebarFeedGestureValue(gestures, 'repo:r')).toEqual({ value: true })
  })

  it('retires on the first install after the host restarts, not on a late one from before', () => {
    const { gestures: requested, ids } = collapse(true)
    let gestures = sidebarFeedGestureAcknowledged(requested, ids[0]!, at(7), at(6))
    gestures = sidebarFeedGesturesInstalled(gestures, at(6))
    expect(gestures.entries).toHaveLength(1)
    gestures = sidebarFeedGesturesInstalled(gestures, at(1, 'g2'))
    expect(gestures.entries).toEqual([])
  })

  it('waits for the new generation when the host restarted before it answered', () => {
    const { gestures: requested, ids } = collapse(true)
    let gestures = sidebarFeedGestureAcknowledged(requested, ids[0]!, at(2, 'g2'), at(6))
    gestures = sidebarFeedGesturesInstalled(gestures, at(7))
    expect(gestures.entries).toHaveLength(1)
    gestures = sidebarFeedGesturesInstalled(gestures, at(1, 'g2'))
    expect(gestures.entries).toHaveLength(1)
    gestures = sidebarFeedGesturesInstalled(gestures, at(2, 'g2'))
    expect(gestures.entries).toEqual([])
  })
})
