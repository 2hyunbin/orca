import type { AccountsSnapshot } from '../components/AccountUsage'
import { MobileHomeQuickActions } from '../components/MobileHomeQuickActions'
import { PickerModal } from '../components/PickerModal'
import { useConnectedHostPicker } from '../components/use-connected-host-picker'
import type { TaskProvider } from '../../../src/shared/task-providers'
import type { HostProfile } from '../transport/types'
import { homeDesktopPickerOptions } from './home-desktop-picker-options'
import { MobileHomeAccountUsageCards } from './MobileHomeAccountUsageCards'
import { MobileHomeAppUpdateCard } from './MobileHomeAppUpdateCard'
import { MobileHomeTasksCard } from './MobileHomeTasksCard'

const DEFAULT_TASK_PROVIDERS: TaskProvider[] = ['github']

/** Below the desktops: the Actions group, account usage, and the app update notice. */
export function MobileHomeListFooter(props: {
  accountsHosts: { host: HostProfile; snapshot: AccountsSnapshot }[]
  connectedHosts: HostProfile[]
  taskProvidersByHost: Record<string, TaskProvider[]>
  onCreateWorkspace: () => void
  onOpenAccounts: (hostId: string) => void
  onOpenTasks: (hostId: string, provider?: TaskProvider) => void
  onPairDesktop: () => void
}) {
  const tasksHostPicker = useConnectedHostPicker(props.connectedHosts)
  const hostProviders = props.connectedHosts.map((host) => ({
    host,
    providers: props.taskProvidersByHost[host.id] ?? DEFAULT_TASK_PROVIDERS
  }))
  const providers = [...new Set(hostProviders.flatMap((entry) => entry.providers))]
  const offeredHostIds = new Set(tasksHostPicker.pickerProps.options.map((option) => option.value))

  function openTasks(provider?: TaskProvider) {
    // Why: a provider chip offers only desktops that have it, so it never opens a different one.
    const hosts = provider
      ? hostProviders
          .filter((entry) => entry.providers.includes(provider))
          .map((entry) => entry.host)
      : props.connectedHosts
    tasksHostPicker.pickHost((hostId) => props.onOpenTasks(hostId, provider), hosts)
  }

  return (
    <>
      <MobileHomeQuickActions
        connectedHosts={props.connectedHosts}
        onPairDesktop={props.onPairDesktop}
        onCreateWorkspace={props.onCreateWorkspace}
      >
        <MobileHomeTasksCard
          enabled={props.connectedHosts.length > 0}
          providers={providers}
          onOpen={openTasks}
        />
      </MobileHomeQuickActions>
      <PickerModal
        title="Open tasks on"
        {...tasksHostPicker.pickerProps}
        options={homeDesktopPickerOptions(
          props.connectedHosts.filter((host) => offeredHostIds.has(host.id))
        )}
      />
      <MobileHomeAccountUsageCards items={props.accountsHosts} onOpen={props.onOpenAccounts} />
      <MobileHomeAppUpdateCard />
    </>
  )
}
