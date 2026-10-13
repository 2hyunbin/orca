import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { useAppStore } from '../../store'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { AiVaultSessionSurfaceSwitchMenuItems } from '../right-sidebar/AiVaultSessionSurfaceSwitchMenuItems'
import { useAiVaultSessionLaunchActions } from '../right-sidebar/ai-vault-session-launch-actions'
import {
  resolveTabSessionHistorySubject,
  type NativeChatTabSession
} from './tab-session-history-switch'
import { isTabStillOpen, runTabSessionSurfaceSwitch } from './tab-session-surface-switch-run'

/** The Session History row's "Resume in New Native Chat" / "Resume in New CLI", offered on the tab
 *  that shows that session. Offered from what the tab knows; the row's gate decides on click, so
 *  the menu never waits on a history scan. */
export function TabSessionSurfaceSwitchMenuItems({
  tab,
  nativeChat,
  leadingSeparator
}: {
  tab: Pick<TerminalTab, 'id' | 'worktreeId'>
  nativeChat?: NativeChatTabSession
  leadingSeparator: boolean
}): React.JSX.Element | null {
  // Mounted only while the menu is open, so this resolves once per right-click.
  const [subject] = useState(() =>
    resolveTabSessionHistorySubject(useAppStore.getState(), {
      tab: { id: tab.id, worktreeId: tab.worktreeId },
      nativeChat
    })
  )
  const targetState = useAppStore(
    useShallow((state) => ({
      projects: state.projects,
      settings: state.settings,
      folderWorkspaces: state.folderWorkspaces,
      projectGroups: state.projectGroups,
      repos: state.repos,
      worktreesByRepo: state.worktreesByRepo
    }))
  )
  const launchActions = useAiVaultSessionLaunchActions({
    activeWorktree: null,
    activeWorktreeId: tab.worktreeId,
    targetState,
    agentCmdOverrides: targetState.settings?.agentCmdOverrides
  })
  if (!subject) {
    return null
  }
  const run = (): void => {
    void runTabSessionSurfaceSwitch({
      subject,
      isSourceOpen: () => isTabStillOpen(tab),
      launch:
        subject.kind === 'chat'
          ? launchActions.handleResumeInNewCli
          : launchActions.handleResumeInNewChat
    })
  }
  return (
    <>
      {leadingSeparator ? <DropdownMenuSeparator /> : null}
      <AiVaultSessionSurfaceSwitchMenuItems
        menuKind="dropdown"
        tooltipSide="right"
        onResumeInNewChat={subject.kind === 'cli' ? run : undefined}
        onResumeInNewCli={subject.kind === 'chat' ? run : undefined}
      />
    </>
  )
}
