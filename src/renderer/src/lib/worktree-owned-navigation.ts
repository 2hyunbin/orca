import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { toast } from 'sonner'
import { queueSetupAndIssueCommands } from './worktree-setup-issue-command-queue'
import { gateWorkspaceWithoutReseed } from './worktree-activation-gated-empty-reseed'
import type { WorktreeActivationOptions } from './worktree-activation-surface-selection'

export function activateOwnedWorktreeNavigation(
  worktreeId: string,
  opts: WorktreeActivationOptions | undefined,
  postActivationState: ReturnType<typeof useAppStore.getState>
): boolean {
  const ownedNavigation =
    opts?.creationOwnsFirstSurface === true &&
    !opts.startup &&
    !opts.defaultTabs &&
    !opts.issueCommand
  if (ownedNavigation) {
    const deliverSetup = (): void => {
      const current = useAppStore.getState()
      const terminalId = current.tabsByWorktree[worktreeId]?.[0]?.id ?? null
      if (
        opts?.setup &&
        (terminalId || (current.settings?.setupScriptLaunchMode ?? 'new-tab') === 'new-tab')
      ) {
        queueSetupAndIssueCommands(
          current,
          worktreeId,
          terminalId,
          opts.setup,
          undefined,
          undefined,
          undefined
        )
      } else if (opts?.setup) {
        toast.error(
          translate(
            'auto.lib.worktree.activation.setupCouldNotRun',
            'Setup could not run. Open a terminal and retry Setup.'
          )
        )
      }
    }
    const hasTerminal = Boolean(postActivationState.tabsByWorktree[worktreeId]?.length)
    const newTabSetup =
      (postActivationState.settings?.setupScriptLaunchMode ?? 'new-tab') === 'new-tab'
    if (hasTerminal || newTabSetup) {
      deliverSetup()
    }
    void gateWorkspaceWithoutReseed(worktreeId).then(() => {
      if (!hasTerminal && !newTabSetup) {
        deliverSetup()
      }
    })
  }

  return ownedNavigation
}
