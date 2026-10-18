import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { Pressable, Text, useWindowDimensions, type View } from 'react-native'
import { AnchoredDetailCard, type DetailCardAnchor } from '../components/AnchoredDetailCard'
import { StatusDot } from '../components/StatusDot'
import { useWindowSafeAreaInsets } from '../layout/side-safe-area'
import type { ConnectionState } from '../transport/types'
import { styles } from './mobile-session-styles'

/** The session's title and status line. A tap opens a card with the full name, where it lives
 *  and its host, as desktop's tab card does, because a sideways phone cuts the title short. */
export function MobileSessionTitleBlock({
  title,
  path,
  hostName,
  connState,
  besideTabs,
  barRef,
  meta,
  showConnectionRetry,
  onRetry
}: {
  title: string
  path: string | null
  hostName: string | null
  connState: ConnectionState
  besideTabs: boolean
  /** The top bar, so the card opens under the bar rather than over it. */
  barRef: RefObject<View | null>
  meta: string
  showConnectionRetry: boolean
  onRetry: () => void
}): React.JSX.Element {
  const blockRef = useRef<View>(null)
  const [anchor, setAnchor] = useState<DetailCardAnchor | null>(null)
  const [open, setOpen] = useState(false)
  const { width } = useWindowDimensions()
  const insets = useWindowSafeAreaInsets()
  const geometry = [width, insets.top, insets.left, insets.right, besideTabs].join(':')
  const measurement = useRef(0)
  const close = useCallback(() => setOpen(false), [])
  const unmount = useCallback(() => setAnchor(null), [])
  // A moved header invalidates the card and any opening measurement still in flight.
  useLayoutEffect(() => {
    close()
    return () => {
      measurement.current += 1
    }
  }, [close, geometry])
  const show = () => {
    const generation = ++measurement.current
    blockRef.current?.measureInWindow((x) => {
      barRef.current?.measureInWindow((_barX, y, _width, height) => {
        if (generation !== measurement.current) {
          return
        }
        setAnchor({ x, y, width: 0, height })
        setOpen(true)
      })
    })
  }
  return (
    <Pressable
      ref={blockRef}
      style={[styles.sessionTitleBlock, besideTabs && styles.sessionTitleBlockBesideTabs]}
      onPress={open ? close : show}
      accessibilityRole="button"
      accessibilityHint="Shows the full workspace name and where it is"
    >
      <Text style={styles.sessionTitle} numberOfLines={1}>
        {title}
      </Text>
      <Pressable
        style={styles.sessionMetaRow}
        disabled={!showConnectionRetry}
        onPress={onRetry}
        accessibilityRole={showConnectionRetry ? 'button' : undefined}
        accessibilityLabel={showConnectionRetry ? 'Reconnect to desktop' : undefined}
      >
        <StatusDot state={connState} />
        <Text style={styles.sessionMetaText} numberOfLines={1}>
          {meta}
        </Text>
      </Pressable>
      {anchor ? (
        <AnchoredDetailCard
          anchor={anchor}
          open={open}
          onDismiss={close}
          onClosed={unmount}
          title={title}
          detail={path}
          footer={
            hostName ? (
              <>
                <StatusDot state={connState} />
                <Text style={styles.sessionMetaText}>
                  {hostName}
                </Text>
              </>
            ) : null
          }
        />
      ) : null}
    </Pressable>
  )
}
