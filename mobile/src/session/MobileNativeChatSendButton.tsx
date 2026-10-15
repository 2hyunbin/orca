import { useRef, useState } from 'react'
import { Pressable, StyleSheet } from 'react-native'
import { ArrowUp, ListPlus } from 'lucide-react-native'
import { ActionSheetModal } from '../components/ActionSheetModal'
import { colors } from '../theme/mobile-theme'
import type { NativeChatFollowUpDelivery } from '../../../src/shared/native-chat-follow-up-delivery'

export function MobileNativeChatSendButton({
  canSend,
  offersChoice,
  onSend
}: {
  canSend: boolean
  offersChoice: boolean
  onSend: (delivery?: NativeChatFollowUpDelivery) => Promise<void>
}): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const longPressed = useRef(false)
  if (menuOpen && (!canSend || !offersChoice)) {
    setMenuOpen(false)
  }
  const choose = (delivery: NativeChatFollowUpDelivery): void => {
    setMenuOpen(false)
    if (canSend && offersChoice) {
      void onSend(delivery)
    }
  }
  return (
    <>
      <Pressable
        accessibilityLabel="Send message"
        accessibilityRole="button"
        style={({ pressed }) => [
          styles.sendButton,
          !canSend && styles.sendButtonDisabled,
          pressed && canSend && styles.pressed
        ]}
        onPressIn={() => {
          longPressed.current = false
        }}
        onPress={() => {
          if (!longPressed.current) {
            return onSend()
          }
        }}
        onLongPress={
          canSend && offersChoice
            ? () => {
                longPressed.current = true
                setMenuOpen(true)
              }
            : undefined
        }
        disabled={!canSend}
      >
        <ArrowUp size={20} color={canSend ? colors.bgBase : colors.textMuted} strokeWidth={2.6} />
      </Pressable>
      <ActionSheetModal
        visible={menuOpen && canSend && offersChoice}
        onClose={() => setMenuOpen(false)}
        actions={[
          { label: 'Queue', icon: ListPlus, onPress: () => choose('queue') },
          { label: 'Steer', icon: ArrowUp, onPress: () => choose('steer') }
        ]}
      />
    </>
  )
}

const styles = StyleSheet.create({
  sendButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.textPrimary
  },
  sendButtonDisabled: {
    backgroundColor: colors.bgRaised
  },
  pressed: {
    opacity: 0.7
  }
})
