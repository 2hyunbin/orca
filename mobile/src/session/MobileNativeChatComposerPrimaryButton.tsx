import { Pressable, StyleSheet } from 'react-native'
import { ArrowUp, Square } from 'lucide-react-native'
import { NATIVE_CHAT_TURN_STATUS_COPY } from '../../../src/shared/native-chat-turn-status'
import { colors } from '../theme/mobile-theme'

/** Present while the host can stop the turn. `stopping`: this phone's own Stop request is in flight. */
export type MobileNativeChatComposerStop = {
  onStop: (() => void) | undefined
  stopping: boolean
}

/** The composer's round button: Send, or Stop when the shared primary action says so. */
export function MobileNativeChatComposerPrimaryButton({
  stop,
  canSend,
  onSend
}: {
  /** Set only while the primary action is Stop. */
  stop: MobileNativeChatComposerStop | null
  canSend: boolean
  onSend: () => Promise<void>
}): React.JSX.Element {
  // Only this phone's own request holds Stop: a repeat is how a stuck stop escalates.
  const enabled = stop ? !stop.stopping : canSend
  const iconColor = enabled ? colors.bgBase : colors.textMuted
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
      onPress={stop ? stop.onStop : onSend}
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
