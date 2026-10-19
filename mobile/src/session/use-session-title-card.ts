import { useCallback, useLayoutEffect, useRef, useState, type ComponentRef } from 'react'
import { Text, useWindowDimensions, type LayoutChangeEvent, type View } from 'react-native'
import type { DetailCardAnchor } from '../components/AnchoredDetailCard'
import { useWindowSafeAreaInsets } from '../layout/side-safe-area'

export function useSessionTitleCard(besideTabs: boolean, obscured: boolean) {
  const layerRef = useRef<View>(null)
  const barRef = useRef<View>(null)
  const titleRef = useRef<ComponentRef<typeof Text>>(null)
  const openerRef = useRef<View>(null)
  const contentRef = useRef<View>(null)
  const [anchor, setAnchor] = useState<DetailCardAnchor | null>(null)
  const [open, setOpen] = useState(false)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const window = useWindowDimensions()
  const insets = useWindowSafeAreaInsets()
  const generation = useRef(0)
  const geometry = [
    window.width,
    insets.top,
    insets.left,
    insets.right,
    besideTabs,
    size.width
  ].join(':')
  const dismiss = useCallback(() => setOpen(false), [])
  const onClosed = useCallback(() => setAnchor(null), [])
  useLayoutEffect(() => {
    dismiss()
    return () => {
      generation.current += 1
    }
  }, [dismiss, geometry, obscured])
  const show = () => {
    if (obscured) {
      return
    }
    const current = ++generation.current
    layerRef.current?.measureInWindow((rootX, rootY) => {
      titleRef.current?.measureInWindow((x, y, width, height) => {
        barRef.current?.measureInWindow((_x, barY, _width, barHeight) => {
          if (current !== generation.current) {
            return
          }
          setAnchor({
            trigger: { x: x - rootX, y: y - rootY, width, height },
            top: barY + barHeight - rootY,
            origin: { x: rootX, y: rootY }
          })
          setOpen(true)
        })
      })
    })
  }
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout
    setSize({ width, height })
  }, [])
  const origin = anchor?.origin ?? { x: 0, y: 0 }
  return {
    layerRef,
    barRef,
    titleRef,
    openerRef,
    contentRef,
    anchor,
    open,
    present: anchor !== null,
    besideTabs,
    dismiss,
    onClosed,
    onLayout,
    toggle: open ? dismiss : show,
    viewport: { x: -origin.x, y: -origin.y, width: window.width, height: window.height },
    bounds: {
      left: Math.max(0, insets.left - origin.x),
      top: Math.max(0, insets.top - origin.y),
      right: Math.min(size.width, window.width - insets.right - origin.x),
      bottom: Math.min(size.height, window.height - insets.bottom - origin.y)
    }
  }
}

export type SessionTitleCard = ReturnType<typeof useSessionTitleCard>
