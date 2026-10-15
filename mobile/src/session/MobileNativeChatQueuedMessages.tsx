import { useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  ListEnd,
  MoreHorizontal,
  Pencil,
  Play,
  Send,
  Trash2
} from 'lucide-react-native'
import { ActionSheetModal } from '../components/ActionSheetModal'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import type { MobileQueuedMessageCard } from './mobile-structured-queued-message-cards'
import type { MobileQueuePause } from './mobile-structured-queued-message-feed'
import type { MobileQueuedMessageEdit } from './use-mobile-structured-queued-message-controls'
import { MobileQueuedCardText } from './MobileQueuedCardText'

/** Held by Resume and Clear all, so each refuses the other; message ids never contain NUL. */
const QUEUE_KEY = '\u0000queue'

export type MobileNativeChatQueuedMessagesProps = {
  cards?: MobileQueuedMessageCard[]
  /** Steer for a waiting card, the paused queue's included; plain Send for a card held on its own
   *  (its send failed), or a returned one. */
  onSend?: (messageId: string) => Promise<boolean>
  onDelete?: (messageId: string) => Promise<boolean>
  onClearAll?: (messageIds: string[]) => Promise<boolean>
  /** Copy the card's text into the composer, then delete the card. */
  onEdit?: MobileQueuedMessageEdit
  /** The whole queue's pause: the header reads Paused, with Clear all and Resume. */
  pause?: MobileQueuePause
  onResume?: () => Promise<boolean>
  /** The chat reads Stopping: no card steers into the turn a Stop is ending. */
  steerHeld?: boolean
}

/** The host-held queued drafts, as one box of compact rows between transcript and
 *  composer — a queued message is never an optimistic transcript bubble. */
export function MobileNativeChatQueuedMessages({
  cards,
  onSend,
  onDelete,
  onClearAll,
  onEdit,
  pause,
  onResume,
  steerHeld = false
}: MobileNativeChatQueuedMessagesProps): React.JSX.Element | null {
  // One in-flight action per control, drawn as busy until it settles; a second tap must not
  // double-consume. The ref closes the same-frame double tap the disabled state cannot.
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set())
  const inFlightRef = useRef(new Set<string>())
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(true)
  if (!cards || cards.length === 0) {
    // Collapsing is local to this queue's run: once it empties, the next card shows open.
    if (!expanded) {
      setExpanded(true)
    }
    return null
  }
  const run = async (keys: readonly string[], action?: () => Promise<boolean>) => {
    const held = inFlightRef.current
    if (!action || keys.some((key) => held.has(key))) {
      return
    }
    keys.forEach((key) => held.add(key))
    setBusyIds(new Set(held))
    try {
      await action()
    } finally {
      keys.forEach((key) => held.delete(key))
      setBusyIds(new Set(held))
    }
  }
  const runOnCard = (messageId: string, action?: (id: string) => Promise<boolean>) =>
    void run([messageId], action && (() => action(messageId)))
  // Each header action greys during the other: a Resume would send the cards a Clear is deleting.
  const queueBusy = busyIds.has(QUEUE_KEY)
  const messageIds = cards.map((card) => card.messageId)
  const clearKeys = [QUEUE_KEY, ...messageIds]
  const clearBusy = clearKeys.some((key) => busyIds.has(key))
  // A card that drained or was removed while its menu was open closes the menu, for good: a
  // Stop-requeued draft comes back under the same id and must not reopen it.
  const menuCard = cards.find((card) => card.messageId === menuFor)
  if (menuFor !== null && !menuCard) {
    setMenuFor(null)
  }
  const attentionCaption = !expanded ? cards.find((card) => card.needsAttention)?.caption : null
  const headerCountStyle = [styles.headerCount, attentionCaption && styles.captionReturned]
  return (
    <View style={styles.list}>
      {/* One box: the header is its first row, and each card a row below it. */}
      <View style={styles.box}>
        {/* A polite region, as the app's other notices: React Native has no status role. */}
        <View
          testID="queued-header"
          style={[styles.row, pause && styles.headerPaused]}
          accessibilityLiveRegion="polite"
        >
          <Text style={[styles.headerLabel, pause && styles.headerLabelPaused]}>
            {pause ? 'Paused' : 'Queued'}
          </Text>
          <Text style={headerCountStyle} numberOfLines={1}>
            {attentionCaption ? `${cards.length} · ${attentionCaption}` : cards.length}
          </Text>
          {pause ? (
            <>
              {onClearAll ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: clearBusy }}
                  accessibilityLabel="Delete every queued message"
                  style={({ pressed }) => [
                    styles.textAction,
                    pressed && styles.pressed,
                    clearBusy && styles.disabled
                  ]}
                  disabled={clearBusy}
                  onPress={() => void run(clearKeys, () => onClearAll(messageIds))}
                >
                  <Trash2 size={12} color={colors.textPrimary} strokeWidth={2} />
                  <Text style={styles.actionLabel}>Clear all</Text>
                </Pressable>
              ) : null}
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: queueBusy }}
                accessibilityLabel="Resume sending the queued messages"
                style={({ pressed }) => [
                  styles.textAction,
                  pressed && styles.pressed,
                  queueBusy && styles.disabled
                ]}
                disabled={queueBusy}
                onPress={() => void run([QUEUE_KEY], onResume)}
              >
                <Play size={12} color={colors.textPrimary} strokeWidth={2} />
                <Text style={styles.actionLabel}>Resume</Text>
              </Pressable>
            </>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            accessibilityLabel="Queued messages"
            style={({ pressed }) => [styles.iconAction, pressed && styles.pressed]}
            onPress={() => setExpanded(!expanded)}
          >
            {expanded ? (
              <ChevronDown size={14} color={colors.textMuted} strokeWidth={2} />
            ) : (
              <ChevronRight size={14} color={colors.textMuted} strokeWidth={2} />
            )}
          </Pressable>
        </View>
        {(expanded ? cards : []).map((card) => {
          const busy = busyIds.has(card.messageId)
          const returned = card.state === 'returned'
          // "Steer" submits beside the running turn, the paused queue's cards too; a card whose
          // own send failed, or a returned one, is sent again.
          const steers = !returned && !card.paused && !card.command
          return (
            <View
              key={card.messageId}
              testID="queued-card-row"
              style={[styles.row, styles.divided]}
            >
              {card.needsAttention ? (
                <AlertCircle size={14} color={colors.statusRed} strokeWidth={2} />
              ) : (
                <ListEnd size={14} color={colors.textMuted} strokeWidth={2} />
              )}
              <View style={styles.textColumn}>
                {card.attribution ? (
                  <Text style={styles.caption} numberOfLines={1}>
                    {card.attribution}
                  </Text>
                ) : null}
                <MobileQueuedCardText text={card.text} />
                {card.caption ? (
                  // A returned card's reason only reads whole, often at its end; a hold is one line.
                  <Text
                    style={[styles.caption, returned && styles.captionReturned]}
                    numberOfLines={returned ? undefined : 1}
                  >
                    {card.caption}
                  </Text>
                ) : null}
              </View>
              {/* A command never steers: its Send shows only while the agent is idle. */}
              {card.waitsForAgent ? null : (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: busy || steerHeld }}
                  accessibilityLabel={
                    returned
                      ? 'Send this message again'
                      : steers
                        ? 'Submit without interrupting the model'
                        : 'Send this message'
                  }
                  style={({ pressed }) => [
                    styles.textAction,
                    pressed && styles.pressed,
                    (busy || steerHeld) && styles.disabled
                  ]}
                  disabled={busy || steerHeld}
                  onPress={() => runOnCard(card.messageId, onSend)}
                >
                  {steers ? (
                    <CornerDownRight size={12} color={colors.textPrimary} strokeWidth={2} />
                  ) : (
                    <Send size={12} color={colors.textPrimary} strokeWidth={2} />
                  )}
                  <Text style={styles.actionLabel}>{steers ? 'Steer' : 'Send'}</Text>
                </Pressable>
              )}
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: busy }}
                accessibilityLabel="Delete this queued message"
                style={({ pressed }) => [
                  styles.iconAction,
                  pressed && styles.pressed,
                  busy && styles.disabled
                ]}
                disabled={busy}
                onPress={() => runOnCard(card.messageId, onDelete)}
              >
                <Trash2 size={14} color={colors.textPrimary} strokeWidth={2} />
              </Pressable>
              {/* The menu holds only Edit, which a command does not take. */}
              {card.command ? null : (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: busy }}
                  accessibilityLabel="More actions"
                  style={({ pressed }) => [
                    styles.iconAction,
                    pressed && styles.pressed,
                    busy && styles.disabled
                  ]}
                  disabled={busy}
                  onPress={() => setMenuFor(card.messageId)}
                >
                  <MoreHorizontal size={14} color={colors.textPrimary} strokeWidth={2} />
                </Pressable>
              )}
            </View>
          )
        })}
      </View>
      <ActionSheetModal
        visible={menuCard !== undefined}
        title={menuCard?.text}
        actions={[
          {
            label: 'Edit message',
            icon: Pencil,
            // Runs once the sheet's Modal is gone, so the composer Edit fills can take focus.
            closeBeforePress: true,
            onPress: () => {
              if (menuCard) {
                runOnCard(menuCard.messageId, onEdit)
              }
            }
          }
        ]}
        onClose={() => setMenuFor(null)}
      />
    </View>
  )
}

// Every action touches as a 44pt target (platform floor) inside its row: Android drops touches
// outside the parent, so the row is at least that tall and nothing overhangs it.
const MIN_TOUCH_TARGET = 44

const styles = StyleSheet.create({
  list: {
    marginHorizontal: spacing.lg,
    marginVertical: spacing.xs
  },
  box: {
    backgroundColor: colors.bgPanel,
    borderRadius: radii.row,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    overflow: 'hidden'
  },
  row: {
    minHeight: MIN_TOUCH_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingLeft: spacing.md
  },
  divided: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle
  },
  headerPaused: {
    backgroundColor: colors.bgRaised
  },
  headerLabel: {
    color: colors.textMuted,
    fontSize: typography.metaSize
  },
  headerLabelPaused: {
    color: colors.textPrimary,
    fontWeight: '500'
  },
  headerCount: {
    flex: 1,
    color: colors.textMuted,
    fontSize: typography.metaSize,
    fontVariant: ['tabular-nums']
  },
  textColumn: {
    flex: 1,
    minWidth: 0,
    paddingVertical: spacing.sm,
    gap: 2
  },
  caption: {
    color: colors.textMuted,
    fontSize: typography.metaSize
  },
  captionReturned: {
    color: colors.statusRed
  },
  textAction: {
    minHeight: MIN_TOUCH_TARGET,
    minWidth: MIN_TOUCH_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.button
  },
  iconAction: {
    minHeight: MIN_TOUCH_TARGET,
    minWidth: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.button
  },
  actionLabel: {
    color: colors.textPrimary,
    fontSize: typography.metaSize,
    fontWeight: '500'
  },
  pressed: {
    backgroundColor: colors.bgRaised
  },
  disabled: {
    opacity: 0.5
  }
})
