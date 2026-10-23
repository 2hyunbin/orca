import type { NativeChatRowTypography } from './native-chat-row-height-estimate'
import { nativeChatPinnedRowIndexes } from './native-chat-pinned-rows'
import { useCallback, useMemo, useRef, useState } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import type { NativeChatSubagentSections } from './native-chat-subagent-sections'
import { nativeChatSlotKey, type NativeChatTranscriptSlot } from './native-chat-transcript-slots'
import { useNativeChatReadingPosition } from './native-chat-reading-position'
export type NativeChatTranscriptWindowOptions = {
  scrollRef: React.RefObject<HTMLDivElement | null>
  slots: readonly NativeChatTranscriptSlot[]
  journalEpoch?: string | null
  readCurrent?: boolean
  subagentSections?: NativeChatSubagentSections
  revealIndex: number
  newRowsMarkerIndex?: number
  typography?: NativeChatRowTypography
  isVisible: boolean
}
type ReadingVirtualizer = Pick<
  Virtualizer<HTMLDivElement, Element>,
  'scrollToIndex' | 'scrollToOffset'
>

export function useNativeChatTranscriptReading({
  scrollRef,
  slots,
  journalEpoch,
  readCurrent,
  subagentSections,
  isVisible,
  revealIndex,
  newRowsMarkerIndex
}: NativeChatTranscriptWindowOptions) {
  const reading = useNativeChatReadingPosition()
  if (
    journalEpoch &&
    reading.current.anchor?.epoch &&
    reading.current.anchor.epoch !== journalEpoch
  ) {
    reading.current = { followingEnd: true, anchor: null }
  }
  const restore = useRef(
    reading.current.anchor && !reading.current.followingEnd ? reading.current.anchor : null
  )
  const [restoring, setRestoring] = useState(restore.current !== null)
  const restoreIndex = restore.current
    ? slots.findIndex((slot) => nativeChatSlotKey(slot) === restore.current?.rowKey)
    : -1
  if (restore.current && readCurrent && restoreIndex < 0) {
    restore.current = null
    reading.current = { ...reading.current, followingEnd: true }
  }
  const pinned = useMemo(() => {
    const indexes = new Set(
      nativeChatPinnedRowIndexes({ count: slots.length, revealIndex, newRowsMarkerIndex })
    )
    if (restoring && restoreIndex >= 0) {
      indexes.add(restoreIndex)
    }
    return indexes
  }, [slots.length, revealIndex, newRowsMarkerIndex, restoring, restoreIndex])
  const reconcile = (virtualizer: ReadingVirtualizer) => {
    const saved = restore.current
    const container = scrollRef.current
    if (!isVisible || !saved || restoreIndex < 0 || !container) {
      return
    }
    let frame = 0
    let stable = 0
    const deadline = performance.now() + 1000
    virtualizer.scrollToIndex(restoreIndex, { align: 'start', behavior: 'auto' })
    const reconcile = () => {
      if (restore.current !== saved) {
        return
      }
      const row = Array.from(
        container.querySelectorAll<HTMLElement>('[data-native-chat-row-key]')
      ).find((element) => element.dataset.nativeChatRowKey === saved.rowKey)
      if (row) {
        const within = Math.min(
          saved.offsetWithinRow,
          Math.max(0, row.getBoundingClientRect().height - 1)
        )
        const delta =
          row.getBoundingClientRect().top - container.getBoundingClientRect().top + within
        if (Math.abs(delta) <= 1) {
          stable += 1
        } else {
          stable = 0
          virtualizer.scrollToOffset(container.scrollTop + delta, { behavior: 'auto' })
        }
        if (stable >= 2) {
          restore.current = null
          setRestoring(false)
          return
        }
      }
      if (performance.now() < deadline) {
        frame = requestAnimationFrame(reconcile)
      }
      // A missed layout deadline keeps the compact anchor for a later authoritative reveal.
    }
    frame = requestAnimationFrame(reconcile)
    return () => cancelAnimationFrame(frame)
  }
  const captureReadingPosition = useCallback(
    (followingEnd: boolean) => {
      const container = scrollRef.current
      if (!isVisible || !container || container.clientHeight <= 0 || restore.current) {
        return
      }
      const { top, bottom } = container.getBoundingClientRect()
      const row = Array.from(
        container.querySelectorAll<HTMLElement>('[data-native-chat-row-key]')
      ).find((element) => {
        const rect = element.getBoundingClientRect()
        return rect.bottom > top && rect.top < bottom
      })
      if (followingEnd) {
        reading.current = { followingEnd, anchor: null }
      } else if (row?.dataset.nativeChatRowKey) {
        const slot = slots[Number(row.dataset.index)]
        const position =
          slot?.kind === 'message'
            ? slot.message.journalPosition
            : slot?.kind === 'subagent'
              ? (subagentSections?.rosters.get(slot.agentId)?.position ??
                subagentSections?.rows.get(slot.agentId)?.[0]?.message.journalPosition)
              : slot?.kind === 'subagent-entries'
                ? slots.find(
                    (entry): entry is Extract<NativeChatTranscriptSlot, { kind: 'message' }> =>
                      entry.kind === 'message' && entry.message.id === slot.rosterRowId
                  )?.message.journalPosition
                : undefined
        reading.current = {
          followingEnd,
          anchor: {
            rowKey: row.dataset.nativeChatRowKey,
            ...(journalEpoch ? { epoch: journalEpoch } : {}),
            ...(position ? { sequence: position.sequence } : {}),
            offsetWithinRow: Math.max(0, top - row.getBoundingClientRect().top)
          }
        }
      } else {
        reading.current = { ...reading.current, followingEnd }
      }
    },
    [isVisible, journalEpoch, reading, scrollRef, slots, subagentSections]
  )

  return {
    pinned,
    reading,
    restore,
    restoring,
    setRestoring,
    restoreIndex,
    reconcile,
    captureReadingPosition
  }
}
