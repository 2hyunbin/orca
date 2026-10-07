import { useCallback, useEffect, useRef, useState } from 'react'
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native'
import type { LegendListRef } from '@legendapp/list/react-native'

export const MOBILE_NATIVE_CHAT_END_THRESHOLD = 0.1
const HISTORY_EDGE = 60
function atEnd(event: NativeScrollEvent): boolean {
  return (
    event.contentSize.height - event.contentOffset.y - event.layoutMeasurement.height <=
    MOBILE_NATIVE_CHAT_END_THRESHOLD * event.layoutMeasurement.height
  )
}

/** Intent changes only through user ownership or an explicit latest command. */
export function useMobileNativeChatListIntent({
  hasMore,
  loadingEarlier,
  onLoadEarlier
}: {
  hasMore?: boolean
  loadingEarlier?: boolean
  onLoadEarlier?: () => void
}) {
  const listRef = useRef<LegendListRef | null>(null)
  const [following, setFollowing] = useState(true)
  const [atTail, setAtTail] = useState(true)
  const userActive = useRef(false)
  const momentum = useRef(false)
  const settleFrame = useRef<number | null>(null)
  const lastUserOffset = useRef<number | null>(null)
  const cancelSettle = useCallback(() => {
    if (settleFrame.current !== null) {
      cancelAnimationFrame(settleFrame.current)
      settleFrame.current = null
    }
  }, [])
  useEffect(() => cancelSettle, [cancelSettle])
  const acquire = useCallback(() => {
    cancelSettle()
    userActive.current = true
    setFollowing(false)
  }, [cancelSettle])
  const beginDrag = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      lastUserOffset.current = event.nativeEvent.contentOffset.y
      acquire()
    },
    [acquire]
  )
  const beginMomentum = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      lastUserOffset.current = event.nativeEvent.contentOffset.y
      momentum.current = true
      acquire()
    },
    [acquire]
  )
  const finish = useCallback(
    (event: NativeScrollEvent) => {
      if (!userActive.current) {
        return
      }
      cancelSettle()
      userActive.current = false
      const latest = atEnd(event)
      setAtTail(latest)
      setFollowing(latest)
    },
    [cancelSettle]
  )
  const endDrag = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!userActive.current || momentum.current) {
        return
      }
      cancelSettle()
      const metrics = event.nativeEvent
      settleFrame.current = requestAnimationFrame(() => {
        settleFrame.current = null
        finish(metrics)
      })
    },
    [cancelSettle, finish]
  )
  const endMomentum = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      momentum.current = false
      finish(event.nativeEvent)
    },
    [finish]
  )
  const loadEarlier = useCallback(() => {
    setFollowing(false)
    onLoadEarlier?.()
  }, [onLoadEarlier])
  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const metrics = event.nativeEvent
      setAtTail(atEnd(metrics))
      if (!userActive.current) {
        return
      }
      const previous = lastUserOffset.current
      const offset = metrics.contentOffset.y
      lastUserOffset.current = offset
      if (
        previous !== null &&
        offset < previous &&
        offset < HISTORY_EDGE &&
        hasMore &&
        !loadingEarlier
      ) {
        onLoadEarlier?.()
      }
    },
    [hasMore, loadingEarlier, onLoadEarlier]
  )
  const jumpToTail = useCallback(() => {
    cancelSettle()
    momentum.current = false
    userActive.current = false
    lastUserOffset.current = null
    setAtTail(true)
    setFollowing(true)
    void listRef.current?.scrollToEnd({ animated: false })
  }, [cancelSettle])
  return {
    listRef,
    following,
    showJumpToTail: !following && !atTail,
    beginDrag,
    beginMomentum,
    endDrag,
    endMomentum,
    onScroll,
    loadEarlier,
    jumpToTail
  }
}
