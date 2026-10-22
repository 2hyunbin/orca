import { StyleSheet, Text, View } from 'react-native'
import { AlertCircle, AlertTriangle, Info, X } from 'lucide-react-native'
import { colors, radii, spacing, textStyles } from '../../theme/mobile-theme'
import { Button } from './Button'
import { IconButton } from './IconButton'

type BannerTone = 'info' | 'warning' | 'error'

type BannerProps = {
  tone?: BannerTone
  title?: string
  message: string
  action?: { label: string; onPress: () => void; busy?: boolean }
  onDismiss?: () => void
  testID?: string
}

const TONE = {
  info: { icon: Info, color: colors.textSecondary, fill: colors.fill },
  warning: { icon: AlertTriangle, color: colors.statusAmber, fill: 'rgba(245, 158, 11, 0.1)' },
  error: { icon: AlertCircle, color: colors.danger, fill: 'rgba(255, 107, 107, 0.1)' }
} as const

/** The one inline notice: status icon, 15 pt text, one compact action, optional dismiss. */
export function Banner({ tone = 'info', title, message, action, onDismiss, testID }: BannerProps) {
  const { icon: Icon, color, fill } = TONE[tone]
  return (
    <View
      style={[styles.banner, { backgroundColor: fill }]}
      accessibilityRole={tone === 'info' ? undefined : 'alert'}
      testID={testID}
    >
      <Icon size={18} color={color} strokeWidth={2.2} style={styles.icon} />
      <View style={styles.main}>
        {title !== undefined ? <Text style={styles.title}>{title}</Text> : null}
        <Text style={styles.message}>{message}</Text>
        {action ? (
          <Button
            label={action.label}
            onPress={action.onPress}
            busy={action.busy}
            size="compact"
            style={styles.action}
          />
        ) : null}
      </View>
      {onDismiss ? (
        <IconButton
          icon={X}
          accessibilityLabel="Dismiss"
          onPress={onDismiss}
          variant="bare"
          iconSize={16}
          iconColor={colors.textMuted}
          style={styles.dismiss}
        />
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    marginHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    paddingLeft: spacing.lg,
    paddingRight: spacing.xs,
    borderRadius: radii.group
  },
  icon: { marginTop: 1 },
  main: { flex: 1, minWidth: 0, gap: 2, paddingRight: spacing.sm },
  title: { ...textStyles.callout, fontWeight: '600', color: colors.textPrimary },
  message: { ...textStyles.callout, color: colors.textSecondary },
  action: { marginTop: spacing.xs },
  dismiss: { marginTop: -10 }
})
