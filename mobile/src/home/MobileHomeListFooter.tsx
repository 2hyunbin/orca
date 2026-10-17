import { StyleSheet, Text, View } from 'react-native'
import type { AccountsSnapshot } from '../components/AccountUsage'
import { MobileHomeQuickActions } from '../components/MobileHomeQuickActions'
import { PickerModal } from '../components/PickerModal'
import { useConnectedHostPicker } from '../components/use-connected-host-picker'
import type { TaskProvider } from '../../../src/shared/task-providers'
import { colors, spacing } from '../theme/mobile-theme'
import type { HostProfile } from '../transport/types'
import type { HomeResumeCard } from '../worktree/home-resume-card'
import { MobileHomeAccountUsageCards } from './MobileHomeAccountUsageCards'
import { MobileHomeResumeCard } from './MobileHomeResumeCard'
import { MobileHomeTasksCard } from './MobileHomeTasksCard'

export function MobileHomeListFooter(props: {
  accountsHosts: { host: HostProfile; snapshot: AccountsSnapshot }[]
  connectedHosts: HostProfile[]
  connectedTaskProviders: TaskProvider[]
  resumeCard: HomeResumeCard | null
  onCreateWorkspace: (hostId: string) => void
  onOpenAccounts: (hostId: string) => void
  onOpenResume: (card: HomeResumeCard) => void
  onOpenTasks: (hostId: string, provider?: TaskProvider) => void
  onPairDesktop: () => void
}) {
  const tasksHostPicker = useConnectedHostPicker(props.connectedHosts)
  return (
    <View>
      {props.resumeCard ? (
        <>
          <Text style={styles.sectionHeading}>Resume</Text>
          <MobileHomeResumeCard card={props.resumeCard} onOpen={props.onOpenResume} />
        </>
      ) : null}
      <Text style={styles.sectionHeading}>Tasks</Text>
      <MobileHomeTasksCard
        enabled={props.connectedHosts.length > 0}
        providers={props.connectedTaskProviders}
        onOpen={(provider) =>
          tasksHostPicker.pickHost((hostId) => props.onOpenTasks(hostId, provider))
        }
      />
      <PickerModal title="Open Tasks On" {...tasksHostPicker.pickerProps} />
      <MobileHomeQuickActions
        connectedHosts={props.connectedHosts}
        onPairDesktop={props.onPairDesktop}
        onCreateWorkspace={props.onCreateWorkspace}
      />
      <MobileHomeAccountUsageCards items={props.accountsHosts} onOpen={props.onOpenAccounts} />
    </View>
  )
}

const styles = StyleSheet.create({
  sectionHeading: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.xs
  }
})
