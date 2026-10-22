import { QrCode } from 'lucide-react-native'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { OrcaLogo } from '../components/OrcaLogo'
import { Button } from '../components/ui/Button'
import { ListGroup, LIST_LEADING_INSET } from '../components/ui/ListGroup'
import { ListRow } from '../components/ui/ListRow'
import { SectionHeader } from '../components/ui/SectionHeader'
import { colors, spacing, textStyles } from '../theme/mobile-theme'

const ONBOARDING_STEPS = [
  {
    title: 'Open Orca desktop',
    desc: 'Go to Settings → Mobile and generate a pairing QR code.'
  },
  {
    title: 'Scan the code',
    desc: 'Tap the button above to open the scanner. Point at the QR code on your screen.'
  },
  {
    title: "You're connected",
    desc: 'Your desktop will appear here. Everything is encrypted end-to-end.'
  }
]

/** First run: the welcome, the one primary "Pair desktop", and the three steps. */
export function MobileHomeEmptyState(props: {
  bottomInset: number
  contentMaxWidth: number
  isWideLayout: boolean
  onPairDesktop: () => void
}) {
  // Scrolls because a phone in landscape is shorter than the hero and the steps together.
  return (
    <ScrollView
      contentContainerStyle={[
        styles.container,
        { paddingBottom: spacing.xl + props.bottomInset },
        props.isWideLayout && {
          maxWidth: props.contentMaxWidth,
          width: '100%',
          alignSelf: 'center'
        }
      ]}
    >
      <View style={styles.hero}>
        <OrcaLogo size={36} color={colors.textPrimary} />
        <Text style={styles.title} accessibilityRole="header">
          Connect your desktop
        </Text>
        <Text style={styles.body}>
          Pair with Orca on your computer to check on your agents, jump into any terminal, and drive
          work from your phone.
        </Text>
        <Button
          label="Pair desktop"
          icon={QrCode}
          variant="primary"
          onPress={props.onPairDesktop}
          style={styles.cta}
        />
      </View>
      <SectionHeader title="How it works" />
      <ListGroup separatorInset={LIST_LEADING_INSET}>
        {ONBOARDING_STEPS.map((step, index) => (
          <ListRow
            key={step.title}
            title={step.title}
            subtitle={step.desc}
            subtitleNumberOfLines={3}
            leading={
              <View style={styles.stepNumber}>
                <Text style={styles.stepNumberText}>{index + 1}</Text>
              </View>
            }
          />
        ))}
      </ListGroup>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  container: { flexGrow: 1 },
  hero: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg + 4,
    paddingTop: spacing.xl,
    paddingBottom: spacing.lg,
    gap: spacing.md
  },
  title: {
    ...textStyles.title,
    color: colors.textPrimary,
    textAlign: 'center',
    marginTop: spacing.sm
  },
  body: {
    ...textStyles.body,
    color: colors.textSecondary,
    textAlign: 'center',
    maxWidth: 340
  },
  cta: { alignSelf: 'center', marginTop: spacing.md },
  stepNumber: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: colors.fill,
    alignItems: 'center',
    justifyContent: 'center'
  },
  stepNumberText: {
    ...textStyles.footnote,
    fontWeight: '600',
    color: colors.textSecondary,
    fontVariant: ['tabular-nums']
  }
})
