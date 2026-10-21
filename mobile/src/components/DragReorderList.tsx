import { DragReorderRow, type DragSharedState } from './DragReorderRow'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { View } from 'react-native'
import Animated, {
  measure,
  runOnJS,
  scrollTo,
  useFrameCallback,
  useSharedValue,
  type AnimatedRef,
  type SharedValue
} from 'react-native-reanimated'
import { triggerSelection } from '../platform/haptics'
import {
  dragReorderTarget,
  dragReorderMove,
  type DragReorderMove,
  dragReorderPositionsFromKeys,
  moveDragReorderKey,
  type DragReorderPositions
} from './drag-reorder-positions'

// Why: joins row keys into a change-detection signature; NUL cannot occur in
// a key, so the joined string is unambiguous.
const KEY_SEPARATOR = '\u0000'
// Why: drags near the viewport edges scroll the outer ScrollView so rows can
// travel further than one screen; speed ramps up the closer the finger gets.
const AUTO_SCROLL_EDGE = 72
const AUTO_SCROLL_MAX_SPEED = 560

export type DragReorderListProps<ItemT> = {
  items: ItemT[]
  itemKey: (item: ItemT) => string
  rowHeight?: number
  scopeKey?: string
  rowPresentation?: 'settings' | 'plain'
  renderRow: (item: ItemT, handle: ReactNode) => ReactNode
  /** Called with every item key in the new order after a drop changes it. */
  onReorder?: (orderedKeys: string[]) => void
  onMove?: (move: DragReorderMove) => void
  /** Lets the owning screen disable its ScrollView while a row is held. */
  onDragActiveChange?: (active: boolean) => void
  scrollRef: AnimatedRef<Animated.ScrollView>
  scrollOffsetY: SharedValue<number>
  scrollContentHeight: SharedValue<number>
}

export function DragReorderList<ItemT>({
  items,
  itemKey,
  rowHeight,
  scopeKey = '',
  rowPresentation = 'settings',
  renderRow,
  onReorder,
  onMove,
  onDragActiveChange,
  scrollRef,
  scrollOffsetY,
  scrollContentHeight
}: DragReorderListProps<ItemT>): React.JSX.Element {
  const keys = items.map(itemKey)
  const keySignature = keys.join(KEY_SEPARATOR)
  const [measured, setMeasured] = useState<Record<string, number>>({})
  const sizes = useSharedValue<Record<string, number>>({})
  const initialPositions = useSharedValue<DragReorderPositions>({})
  const rowSizes = useMemo(
    () =>
      Object.fromEntries(
        (keySignature ? keySignature.split(KEY_SEPARATOR) : []).map((key) => [
          key,
          rowHeight ?? measured[key] ?? 0
        ])
      ),
    [keySignature, rowHeight, measured]
  )
  const ready = keys.every((key) => rowSizes[key] > 0)
  const height = Object.values(rowSizes).reduce((sum, size) => sum + size, 0)
  const onMeasure = useCallback((key: string, height: number) => {
    setMeasured((current) => (current[key] === height ? current : { ...current, [key]: height }))
  }, [])
  const positions = useSharedValue<DragReorderPositions>(dragReorderPositionsFromKeys(keys))
  const activeKey = useSharedValue<string | null>(null)
  const activeTop = useSharedValue(0)
  const dragStartTop = useSharedValue(0)
  const dragStartScrollY = useSharedValue(0)
  const dragTranslationY = useSharedValue(0)
  const dragPointerAbsY = useSharedValue(0)

  const signature = `${scopeKey}${KEY_SEPARATOR}${keySignature}`
  const currentSignature = useRef(signature)
  useLayoutEffect(() => {
    currentSignature.current = signature
  }, [signature])
  useEffect(() => {
    sizes.value = rowSizes
  }, [rowSizes, sizes])

  const updateDragPosition = (key: string): void => {
    'worklet'
    const rawTop =
      dragStartTop.value + dragTranslationY.value + (scrollOffsetY.value - dragStartScrollY.value)
    const top = Math.min(Math.max(rawTop, 0), Math.max(0, height - (sizes.value[key] ?? 0)))
    activeTop.value = top
    const target = dragReorderTarget(positions.value, sizes.value, key, top)
    if (positions.value[key] !== target) {
      positions.value = moveDragReorderKey(positions.value, key, target)
      runOnJS(triggerSelection)()
    }
  }

  // Why: pan updates stop while the finger holds still at a screen edge, so a
  // frame callback keeps scrolling (and re-slotting the row) until it moves.
  const autoScroll = useFrameCallback((frame) => {
    const key = activeKey.value
    if (key === null) {
      return
    }
    const viewport = measure(scrollRef)
    if (viewport) {
      const topEdge = viewport.pageY + AUTO_SCROLL_EDGE
      const bottomEdge = viewport.pageY + viewport.height - AUTO_SCROLL_EDGE
      let velocity = 0
      if (dragPointerAbsY.value < topEdge) {
        velocity =
          -AUTO_SCROLL_MAX_SPEED * Math.min(1, (topEdge - dragPointerAbsY.value) / AUTO_SCROLL_EDGE)
      } else if (dragPointerAbsY.value > bottomEdge) {
        velocity =
          AUTO_SCROLL_MAX_SPEED *
          Math.min(1, (dragPointerAbsY.value - bottomEdge) / AUTO_SCROLL_EDGE)
      }
      if (velocity !== 0) {
        const maxOffset = Math.max(0, scrollContentHeight.value - viewport.height)
        const dtMs = frame.timeSincePreviousFrame ?? 16
        const next = Math.min(
          Math.max(scrollOffsetY.value + (velocity * dtMs) / 1000, 0),
          maxOffset
        )
        if (next !== scrollOffsetY.value) {
          scrollOffsetY.value = next
          scrollTo(scrollRef, 0, next, false)
        }
      }
    }
    updateDragPosition(key)
  }, false)

  const dragActiveCallback = useRef(onDragActiveChange)
  useLayoutEffect(() => {
    dragActiveCallback.current = onDragActiveChange
  }, [onDragActiveChange])
  const setAutoScrollActive = autoScroll.setActive
  const handleDragActiveChange = useCallback(
    (active: boolean) => {
      setAutoScrollActive(active)
      dragActiveCallback.current?.(active)
    },
    [setAutoScrollActive]
  )

  const commitReorder = useCallback(
    (orderedKeys: string[], movedId: string) => {
      // Why: a cancelled or no-op drag should not trigger a persisted write.
      if (
        currentSignature.current === signature &&
        orderedKeys.join(KEY_SEPARATOR) !== keySignature
      ) {
        onReorder?.(orderedKeys)
        const move = dragReorderMove(orderedKeys, movedId)
        if (move) {
          onMove?.(move)
        }
      }
    },
    [onReorder, onMove, keySignature, signature]
  )

  // Why: screen-reader users can't long-press-drag; the handle exposes
  // move up/down accessibility actions that commit the same reorder.
  const moveRowByAccessibilityAction = useCallback(
    (key: string, delta: number) => {
      const fromIndex = keys.indexOf(key)
      if (fromIndex === -1) {
        return
      }
      const toIndex = Math.min(Math.max(fromIndex + delta, 0), keys.length - 1)
      if (toIndex === fromIndex) {
        return
      }
      const next = [...keys]
      next.splice(fromIndex, 1)
      next.splice(toIndex, 0, key)
      commitReorder(next, key)
    },
    [keys, commitReorder]
  )

  useEffect(() => {
    if (activeKey.value !== null) {
      handleDragActiveChange(false)
    }
    activeKey.value = null
    positions.value = dragReorderPositionsFromKeys(
      keySignature ? keySignature.split(KEY_SEPARATOR) : []
    )
  }, [signature, keySignature, positions, activeKey, handleDragActiveChange])
  useEffect(() => () => handleDragActiveChange(false), [handleDragActiveChange])

  const shared: DragSharedState = {
    sizes,
    initialPositions,
    positions,
    activeKey,
    activeTop,
    dragStartTop,
    dragStartScrollY,
    dragTranslationY,
    dragPointerAbsY
  }

  return (
    <View style={ready ? { height } : undefined}>
      {items.map((item) => (
        <DragReorderRow
          key={itemKey(item)}
          rowKey={itemKey(item)}
          rowHeight={rowHeight}
          ready={ready}
          presentation={rowPresentation}
          onMeasure={onMeasure}
          shared={shared}
          scrollOffsetY={scrollOffsetY}
          updateDragPosition={updateDragPosition}
          onDragActiveChange={handleDragActiveChange}
          onCommit={commitReorder}
          onAccessibilityMove={moveRowByAccessibilityAction}
          renderContent={(handle) => renderRow(item, handle)}
        />
      ))}
    </View>
  )
}
