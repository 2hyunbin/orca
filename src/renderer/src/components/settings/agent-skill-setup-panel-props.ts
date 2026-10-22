import type { ComponentProps, ReactNode } from 'react'
import type { Button } from '../ui/button'

type AgentSkillSetupPanelVariant = 'card' | 'inline'

export type AgentSkillSetupPanelProps = {
  title: string
  description: ReactNode
  skillNames: readonly string[]
  // An installed copy may use another name (the legacy Linear skill).
  installedSkillNames?: readonly string[]
  installed: boolean
  loading: boolean
  error: string | null
  installDisabled?: boolean
  leading?: ReactNode
  icon?: ReactNode
  variant?: AgentSkillSetupPanelVariant
  className?: string
  // Enclosing modals can own the title and status.
  hideHeader?: boolean
  onBeforeInstall?: () => void | Promise<void>
  showInstallWhenInstalled?: boolean
  showRecheckWhenInstalled?: boolean
  installLabel?: string
  installedInstallLabel?: string
  // Modal footers can promote Install to the primary action.
  installVariant?: ComponentProps<typeof Button>['variant']
  actionHint?: ReactNode
  footer?: ReactNode
  onRecheck: () => void | Promise<unknown>
  // Freshness inventory is local-host-only.
  freshnessSkillName?: string
}
