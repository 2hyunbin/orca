import { useCallback } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import { newAgentPromptOutcome } from '@/lib/new-agent-prompt-outcome'
import { activeAgentNotesSendFailureMessage } from '@/lib/active-agent-note-send-result'
import type { NewTabAgentMenuRow } from '@/lib/new-tab-agent-menu-rows'
import type { QuickLaunchAgentMenuItemsProps } from './QuickLaunchButton'
import type { NewTabAgentMenuModel } from './use-new-tab-agent-menu-rows'
const getCatalogEntry = (agent: string) => getAgentCatalog().find((entry) => entry.id === agent)

export function shouldShowLaunchWatchdogTimeout({ hasPty }: { hasPty: boolean }): boolean {
  return !hasPty
}

function getLaunchWatchdogTimeoutMessage(label: string): string {
  return `Couldn't launch ${label} — the terminal did not start.`
}

function getTerminalLaunchState(tabId: string): { stillOpen: boolean; hasPty: boolean } {
  const state = useAppStore.getState()
  const hasPtyBinding = (state.ptyIdsByTabId[tabId]?.length ?? 0) > 0
  let stillOpen = false
  let tabPtyId: string | null = null

  for (const tabs of Object.values(state.tabsByWorktree)) {
    const tab = tabs.find((t) => t.id === tabId)
    if (tab) {
      stillOpen = true
      tabPtyId = tab.ptyId
      break
    }
  }

  return { stillOpen, hasPty: hasPtyBinding || tabPtyId !== null }
}

async function waitForTerminalPty(tabId: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const launchState = getTerminalLaunchState(tabId)
    if (launchState.hasPty) {
      return true
    }
    await new Promise((resolve) => window.setTimeout(resolve, 100))
  }
  return getTerminalLaunchState(tabId).hasPty
}

export function useTabAgentMenuLaunch(
  {
    worktreeId,
    groupId,
    onFocusTerminal,
    prompt,
    promptDelivery,
    launchSource,
    onPromptDelivered,
    onPromptHandedOff,
    disabled,
    onFocusHostTerminal
  }: QuickLaunchAgentMenuItemsProps & { onFocusHostTerminal?: () => void },
  model: Pick<NewTabAgentMenuModel, 'validate'>
) {
  const runLaunch = useCallback(
    (row: NewTabAgentMenuRow) => {
      if (disabled || row.kind === 'chat-unavailable') {
        return
      }
      if (!model.validate(row)) {
        toast.error(
          translate(
            'auto.components.right.sidebar.SourceControlAgentActionDialog.8e856842d1',
            'Could not start the selected agent.'
          )
        )
        return
      }
      const { agent } = row
      const entry = getCatalogEntry(agent)
      const label = entry?.label ?? agent
      const result = launchAgentInNewTab({
        requestId: newAgentLaunchRequestId(),
        ...(row.kind === 'chat' || row.kind === 'cli'
          ? {
              requestedSurface: row.kind === 'chat' ? ('chat' as const) : ('terminal' as const),
              selectedExecutionHostId: row.selection?.executionHostId
            }
          : {}),
        agent,
        worktreeId,
        groupId,
        ...(prompt !== undefined ? { prompt } : {}),
        ...(promptDelivery !== undefined ? { promptDelivery } : {}),
        ...(launchSource !== undefined ? { launchSource } : {}),
        ...(onPromptDelivered !== undefined ? { onPromptDelivered } : {}),
        // Notes keep their text until it goes out, so the new chat's composer never gets a copy.
        ...(onPromptHandedOff ? { promptKeptByCaller: true as const } : {})
      })
      if (!result) {
        toast.error(
          translate(
            'auto.components.tab.bar.QuickLaunchButton.465e432ef1',
            'Could not build launch command for {{value0}}.',
            { value0: label }
          )
        )
        return
      }
      if (onPromptHandedOff && result.promptDeliveryResult) {
        const outcome = newAgentPromptOutcome({ delivery: result.promptDeliveryResult })
        onPromptHandedOff(outcome)
        // The notes keep the text, so they say once why it did not go, as a send to a chat does.
        void outcome.then(({ failure }) => {
          if (failure) {
            toast.error(
              translate('auto.store.slices.ui.53883b7bc3', "Couldn't send to {{value0}}", {
                value0: label
              }),
              {
                description: activeAgentNotesSendFailureMessage(failure.status, {
                  explicitTarget: true,
                  code: failure.code
                })
              }
            )
          }
        })
      }
      if (result.surface.kind !== 'local-terminal') {
        onFocusHostTerminal?.()
        return
      }
      onFocusTerminal(result.surface.tabId)

      // Why: launch success means the terminal session exists. Agent readiness
      // can lag behind on slow machines, and prompt paste flows already own
      // their own readiness timeout once a PTY exists.
      const launchedTabId = result.surface.tabId
      void waitForTerminalPty(launchedTabId, 5000).then((hasPty) => {
        if (hasPty) {
          return
        }
        const launchState = getTerminalLaunchState(launchedTabId)
        if (!launchState.stillOpen) {
          return
        }
        if (useAppStore.getState().activeWorktreeId !== worktreeId) {
          return
        }
        if (!shouldShowLaunchWatchdogTimeout({ hasPty: launchState.hasPty })) {
          return
        }
        toast.message(getLaunchWatchdogTimeoutMessage(label))
      })
    },
    [
      worktreeId,
      groupId,
      onFocusTerminal,
      prompt,
      promptDelivery,
      launchSource,
      onPromptDelivered,
      onPromptHandedOff,
      disabled,
      model,
      onFocusHostTerminal
    ]
  )

  return runLaunch
}
