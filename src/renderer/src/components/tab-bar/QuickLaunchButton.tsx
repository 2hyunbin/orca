import React, { useCallback } from 'react'
import { Settings as SettingsIcon } from 'lucide-react'
import { toast } from 'sonner'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut
} from '@/components/ui/dropdown-menu'
import { getAgentCatalog, AgentIcon } from '@/lib/agent-catalog'
import { useAppStore } from '@/store'
import { useAgentDetectionTargetForWorktree } from '@/hooks/useAgentDetectionTarget'
import { useDetectedAgents } from '@/hooks/useDetectedAgents'
import { useOptionalShortcutLabel } from '@/hooks/useShortcutLabel'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { LaunchSource } from '../../../../shared/telemetry-events'
import { translate } from '@/i18n/i18n'
import { newAgentPromptOutcome } from '@/lib/new-agent-prompt-outcome'
import { activeAgentNotesSendFailureMessage } from '@/lib/active-agent-note-send-result'
import type { ChatUnavailableReason, NewTabAgentMenuRow } from '@/lib/new-tab-agent-menu-rows'
import { useNewTabAgentMenuRows } from './use-new-tab-agent-menu-rows'
import { explicitAgentLaunchPlan, rejectExplicitChat } from './tab-agent-launch-action'

export type QuickLaunchAgentMenuItemsProps = {
  worktreeId: string
  groupId: string
  /** Called after the tab is created so keyboard focus lands in the new xterm.
   *  Reuses the TabBar's existing double-rAF handoff — this component does
   *  not duplicate the focus logic. */
  onFocusTerminal: (tabId: string) => void
  /** Optional initial prompt forwarded to `launchAgentInNewTab`. When set,
   *  the picked agent boots with this prompt — argv/flag agents auto-submit,
   *  followup-path agents land it as a draft for the user to confirm. */
  prompt?: string
  /** Use non-default modes for generated context that must not become shell syntax. */
  promptDelivery?: 'auto-submit' | 'draft' | 'submit-after-ready'
  /** Telemetry surface for `agent_started.launch_source`. Defaults to
   *  `'tab_bar_quick_launch'` so the existing tab-bar `+` callsite is
   *  unchanged. */
  launchSource?: LaunchSource
  /** Called after a prompt is queued into the agent, or immediately for argv prompt launches. */
  onPromptDelivered?: () => void
  /** Given the launch's own delivery result while the prompt is still on its way. */
  onPromptHandedOff?: (delivered: Promise<unknown>) => void
  /** Nothing to send: e.g. every note is already on its way, so no agent is started. */
  disabled?: boolean
}

function getCatalogEntry(agent: TuiAgent): { id: TuiAgent; label: string } | null {
  return getAgentCatalog().find((a) => a.id === agent) ?? null
}

function chatUnavailableLabel(reason: ChatUnavailableReason): string {
  switch (reason) {
    case 'pending':
      return translate(
        'auto.components.tab.bar.QuickLaunchButton.chatLoading',
        'Checking chat support…'
      )
    case 'not-installed':
      return translate(
        'auto.components.tab.bar.QuickLaunchButton.chatNotInstalled',
        'Not installed'
      )
    case 'ssh':
      return translate(
        'auto.components.tab.bar.QuickLaunchButton.chatNotOverSsh',
        'No chat over SSH'
      )
    case 'wsl':
      return translate('auto.components.tab.bar.QuickLaunchButton.chatNotInWsl', 'No chat in WSL')
    case 'not-on-host':
      return translate(
        'auto.components.tab.bar.QuickLaunchButton.chatNotOnHost',
        'No chat on this host'
      )
  }
}

function rowTitle(row: NewTabAgentMenuRow, label: string): string {
  if (row.kind === 'chat') {
    return translate(
      'auto.components.tab.bar.QuickLaunchButton.startChat',
      'Start a {{value0}} chat',
      {
        value0: label
      }
    )
  }
  return translate(
    'auto.components.tab.bar.QuickLaunchButton.ec2adf093e',
    'Launch {{value0}} in a new terminal',
    { value0: label }
  )
}

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

function QuickLaunchAgentMenuItemsInner({
  worktreeId,
  groupId,
  onFocusTerminal,
  prompt,
  promptDelivery,
  launchSource,
  onPromptDelivered,
  onPromptHandedOff,
  disabled = false
}: QuickLaunchAgentMenuItemsProps): React.JSX.Element | null {
  // Why: resolving only the SSH connectionId here made paired-runtime
  // worktrees fall back to LOCAL detection, listing the client's agents
  // instead of the remote server's. Use the same ssh/runtime/local owner
  // resolution as the rest of the tab bar.
  const agentDetectionTarget = useAgentDetectionTargetForWorktree(worktreeId)
  const { detectedIds, detectionFailed, needsServerUpdate } =
    useDetectedAgents(agentDetectionTarget)
  const defaultAgent = useAppStore((s) => s.settings?.defaultTuiAgent)
  const rows = useNewTabAgentMenuRows(worktreeId, detectedIds) ?? []
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const newAgentShortcut = useOptionalShortcutLabel('tab.newAgent')

  const openAgentSettings = useCallback(() => {
    openSettingsTarget({ pane: 'agents', repoId: null })
    openSettingsPage()
  }, [openSettingsPage, openSettingsTarget])

  const runLaunch = useCallback(
    (row: NewTabAgentMenuRow) => {
      if (disabled) {
        return
      }
      const { agent } = row
      const entry = getCatalogEntry(agent)
      const label = entry?.label ?? agent
      const result = launchAgentInNewTab({
        ...(row.kind === 'chat' || row.kind === 'cli'
          ? {
              agentSessionLaunchPlan: explicitAgentLaunchPlan(
                row.kind === 'chat' ? 'chat' : 'cli',
                agent,
                worktreeId,
                newAgentLaunchRequestId()
              )
            }
          : { requestId: newAgentLaunchRequestId() }),
        agent,
        worktreeId,
        groupId,
        ...(prompt !== undefined ? { prompt } : {}),
        ...(promptDelivery !== undefined ? { promptDelivery } : {}),
        ...(launchSource !== undefined ? { launchSource } : {}),
        ...(onPromptDelivered !== undefined ? { onPromptDelivered } : {}),
        // Notes keep their text until it goes out, so the new chat's composer never gets a copy.
        ...(onPromptHandedOff ? { promptKeptByCaller: true as const } : {}),
        ...(row.kind === 'chat'
          ? {
              onStructuredHostDeclined: () => rejectExplicitChat(label)
            }
          : {})
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
        if (row.kind === 'chat' && result.structuredSettlement) {
          void result.structuredSettlement.then((settlement) => {
            if (settlement.kind === 'failed' && !settlement.notified) {
              toast.error(
                translate(
                  'auto.components.tab.bar.QuickLaunchButton.chatUnavailableAfterSelection',
                  "Couldn't start a {{value0}} chat.",
                  { value0: label }
                )
              )
            }
          })
        }
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
      disabled
    ]
  )

  return (
    <>
      {rows.length === 0 ? (
        <DropdownMenuItem
          disabled
          className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 text-muted-foreground"
        >
          {needsServerUpdate
            ? translate(
                'auto.components.tab.bar.QuickLaunchButton.needsServerUpdate',
                'Update Orca on this server to list this workspace’s agents'
              )
            : detectionFailed
              ? translate(
                  'auto.components.tab.bar.QuickLaunchButton.hostUnreachable',
                  'Can’t reach this workspace’s host to list its agents'
                )
              : detectedIds && detectedIds.length > 0
                ? translate(
                    'auto.components.tab.bar.QuickLaunchButton.8dea9b5cdf',
                    'No enabled agents'
                  )
                : translate(
                    'auto.components.tab.bar.QuickLaunchButton.e518f544b1',
                    'No agents detected'
                  )}
        </DropdownMenuItem>
      ) : null}
      {rows.map((row, index) => {
        const { agent } = row
        const label = getCatalogEntry(agent)?.label ?? agent
        // Chat rows come first; the rows that open a terminal start their own group.
        const startsCliGroup = row.kind === 'cli' && index > 0 && rows[index - 1]?.kind !== 'cli'
        if (row.kind === 'chat-unavailable') {
          return (
            <DropdownMenuItem key={`${row.kind}:${agent}`} variant="launch" disabled>
              <AgentIcon agent={agent} size={14} />
              <span className="flex-1">{label}</span>
              <span className="font-normal text-muted-foreground">
                {chatUnavailableLabel(row.reason)}
              </span>
            </DropdownMenuItem>
          )
        }
        const showsDefaultAgentShortcut =
          newAgentShortcut !== null && defaultAgent !== 'blank' && agent === defaultAgent
        return (
          <React.Fragment key={`${row.kind}:${agent}`}>
            {startsCliGroup ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem
              variant="launch"
              disabled={disabled}
              onSelect={() => runLaunch(row)}
              title={rowTitle(row, label)}
            >
              <AgentIcon agent={agent} size={14} />
              <span className="flex-1">
                {label}
                {row.kind === 'cli' ? (
                  <span className="ml-1 font-normal text-muted-foreground">
                    {translate('auto.components.tab.bar.QuickLaunchButton.cliTag', '(CLI)')}
                  </span>
                ) : null}
              </span>
              {showsDefaultAgentShortcut ? (
                <DropdownMenuShortcut>{newAgentShortcut}</DropdownMenuShortcut>
              ) : null}
            </DropdownMenuItem>
          </React.Fragment>
        )
      })}
      <DropdownMenuItem
        onSelect={openAgentSettings}
        className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium text-muted-foreground"
      >
        <SettingsIcon className="size-4" />
        {translate('auto.components.tab.bar.QuickLaunchButton.348a04c1ad', 'Agent settings…')}
      </DropdownMenuItem>
    </>
  )
}

export const QuickLaunchAgentMenuItems = React.memo(QuickLaunchAgentMenuItemsInner)
