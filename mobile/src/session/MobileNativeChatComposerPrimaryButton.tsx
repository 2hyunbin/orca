import { useRef } from 'react'
import { Pressable, StyleSheet } from 'react-native'
import { ArrowUp, Square } from 'lucide-react-native'
import { NATIVE_CHAT_TURN_STATUS_COPY } from '../../../src/shared/native-chat-turn-status'
import { colors } from '../theme/mobile-theme'

/** Present while the host can stop the turn. `stopping`: this phone's own Stop request is in flight. */
export type MobileNativeChatComposerStop = {
  onStop: (() => void) | undefined
  stopping: boolean
}

// A double tap or impatient re-tap lands within ~300 ms (the platforms' double-tap timeout);
// 500 ms is the common double-click ceiling and still lets a deliberate Stop through.
const STOP_AFTER_SEND_GUARD_MS = 500

/** The composer's round button: Send, or Stop when the shared composer rule says so. */
export function MobileNativeChatComposerPrimaryButton({
  sendSurfaceId,
  stop,
  canSend,
  onSend
}: {
  sendSurfaceId: string
  /** Set only while the button is Stop. */
  stop: MobileNativeChatComposerStop | null
  canSend: boolean
  onSend: () => Promise<void>
}): React.JSX.Element {
  // Only this phone's own request holds Stop: a repeat is how a stuck stop escalates.
  const enabled = stop ? !stop.stopping : canSend
  const iconColor = enabled ? colors.bgBase : colors.textMuted
  // A quick second tap after Send may land on Stop; other action changes must not block it.
  const lastSendRef = useRef<{ surfaceId: string; at: number } | null>(null)
  const handleSend = (): Promise<void> => {
    lastSendRef.current = { surfaceId: sendSurfaceId, at: Date.now() }
    return onSend()
  }
  const onStop = stop?.onStop
  const handleStop = (): void => {
    const lastSend = lastSendRef.current
    if (
      lastSend?.surfaceId !== sendSurfaceId ||
      Date.now() - lastSend.at >= STOP_AFTER_SEND_GUARD_MS
    ) {
      onStop?.()
    }
  }
  return (
    <Pressable
      accessibilityLabel={
        stop
          ? stop.stopping
            ? NATIVE_CHAT_TURN_STATUS_COPY.stopping
            : 'Stop the agent'
          : 'Send message'
      }
      style={({ pressed }) => [
        styles.button,
        !enabled && styles.buttonDisabled,
        pressed && enabled && styles.pressed
      ]}
      onPress={stop ? handleStop : handleSend}
      disabled={!enabled}
    >
      {stop ? (
        <Square size={14} color={iconColor} fill={iconColor} strokeWidth={2.4} />
      ) : (
        <ArrowUp size={20} color={iconColor} strokeWidth={2.6} />
      )}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  button: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    // White send affordance per design — dark arrow on a light circle.
    backgroundColor: colors.textPrimary
  },
  buttonDisabled: {
    backgroundColor: colors.bgRaised
  },
  pressed: {
    opacity: 0.7
  }
})
