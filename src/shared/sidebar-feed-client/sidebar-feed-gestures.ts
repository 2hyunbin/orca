import type { SidebarFeedNotice } from './sidebar-feed-reader'

/** A feed position: revisions order only within one generation (one run of the host). */
export type SidebarFeedPosition = SidebarFeedNotice

type Gesture<Value> = {
  gestureId: number
  key: string
  value: Value
  /** The host's position for the write, and the generation installed when that answer arrived. */
  acknowledged: { at: SidebarFeedPosition; installedGeneration: string | null } | null
}

/**
 * The only list state a client draws ahead of the host (drag/drop, collapse): one entry per
 * gesture, stacked per key in request order. An entry retires on the host's refusal, or once an
 * install reaches the revision that acknowledged it; never because a value happens to match.
 */
export type SidebarFeedGestures<Value> = {
  readonly entries: readonly Gesture<Value>[]
  readonly lastGestureId: number
}

export function emptySidebarFeedGestures<Value>(): SidebarFeedGestures<Value> {
  return { entries: [], lastGestureId: 0 }
}

/** Starts a gesture; its id goes with the request to the host. */
export function requestSidebarFeedGesture<Value>(
  gestures: SidebarFeedGestures<Value>,
  key: string,
  value: Value
): { gestures: SidebarFeedGestures<Value>; gestureId: number } {
  const gestureId = gestures.lastGestureId + 1
  return {
    gestureId,
    gestures: {
      entries: [...gestures.entries, { gestureId, key, value, acknowledged: null }],
      lastGestureId: gestureId
    }
  }
}

/** The host applied the gesture at `at`; `installed` is the client's install as the answer lands. */
export function sidebarFeedGestureAcknowledged<Value>(
  gestures: SidebarFeedGestures<Value>,
  gestureId: number,
  at: SidebarFeedPosition,
  installed: SidebarFeedPosition | null
): SidebarFeedGestures<Value> {
  const acknowledged = { at, installedGeneration: installed?.generation ?? null }
  const entries = gestures.entries.map((entry) =>
    entry.gestureId === gestureId && !entry.acknowledged ? { ...entry, acknowledged } : entry
  )
  const next = { ...gestures, entries }
  return installed ? sidebarFeedGesturesInstalled(next, installed) : next
}

/** The host refused: the gesture never happened. The caller shows the existing notice. */
export function sidebarFeedGestureRefused<Value>(
  gestures: SidebarFeedGestures<Value>,
  gestureId: number
): SidebarFeedGestures<Value> {
  const entries = gestures.entries.filter((entry) => entry.gestureId !== gestureId)
  return entries.length === gestures.entries.length ? gestures : { ...gestures, entries }
}

function shownBy(entry: Gesture<unknown>, installed: SidebarFeedPosition): boolean {
  const { acknowledged } = entry
  if (!acknowledged) {
    return false
  }
  if (installed.generation === acknowledged.at.generation) {
    return installed.revision >= acknowledged.at.revision
  }
  // A generation newer than the one installed at the answer was read after the host restarted, so
  // it shows what the host kept. A late install of that older generation shows nothing new.
  return installed.generation !== acknowledged.installedGeneration
}

/** On each install: retires every gesture the installed revision shows. */
export function sidebarFeedGesturesInstalled<Value>(
  gestures: SidebarFeedGestures<Value>,
  installed: SidebarFeedPosition
): SidebarFeedGestures<Value> {
  const entries = gestures.entries.filter((entry) => !shownBy(entry, installed))
  return entries.length === gestures.entries.length ? gestures : { ...gestures, entries }
}

/** What the client draws for `key`: its newest unretired gesture's value, else the feed's. */
export function sidebarFeedGestureValue<Value>(
  gestures: SidebarFeedGestures<Value>,
  key: string
): { value: Value } | null {
  for (let index = gestures.entries.length - 1; index >= 0; index -= 1) {
    const entry = gestures.entries[index]
    if (entry?.key === key) {
      return { value: entry.value }
    }
  }
  return null
}
