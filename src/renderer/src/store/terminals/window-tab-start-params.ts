// Layout-owner build: the `terminal.create` params a window tab's first start sends main, carrying
// every start input its own pane's spawn would have carried (ledger L252).

import { toAgentLaunchPreferences } from '../../../../shared/agent-launch-preferences'
import { TUI_AGENT_CONFIG } from '../../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { AppState } from '../types'
import {
  agentStartupDeliveryKey,
  markAgentStartupDeliveryConsumed,
  releaseAgentStartupDeliveryConsumed
} from '@/lib/agent-startup-delivery-guards'
import { forgetMainStartedPane, noteMainStartsPane } from './main-started-pane-view'

type TabStartup = AppState['pendingStartupByTabId'][string]

/** The draft main pastes once its agent is ready: one the agent's launch cannot carry itself. */
export function startupDraftPaste(
  startup: TabStartup | undefined
): { agent: TuiAgent; content: string } | null {
  const agent = startup?.launchAgent ?? startup?.initialAgentStatus?.agent
  const config = agent ? TUI_AGENT_CONFIG[agent] : null
  // As the pane's own paste: only a launch-bound draft, never one the command already carries.
  return agent &&
    startup?.launchConfig &&
    startup.draftPrompt?.trim() &&
    !config?.draftPromptFlag &&
    !config?.draftPromptEnvVar
    ? { agent, content: startup.draftPrompt }
    : null
}

/** The OpenCode model start, which the window's spawn sent through `createAgentSession`. */
function openCodeModelStart(startup: TabStartup): Record<string, unknown> | null {
  const launchPreferences = toAgentLaunchPreferences(startup.sessionOptions)
  if (startup.launchAgent !== 'opencode' || !launchPreferences) {
    return null
  }
  const prompt = startup.initialAgentStatus?.prompt ?? startup.draftPrompt
  return {
    startupAgent: 'opencode',
    ...(startup.agentArgsOverride !== undefined ? { agentArgs: startup.agentArgsOverride } : {}),
    launchPreferences,
    ...(prompt
      ? {
          startupPrompt: prompt,
          startupPromptDelivery: startup.initialAgentStatus?.prompt ? 'auto-submit' : 'draft'
        }
      : {}),
    ...(startup.resumeProviderSession
      ? { resumeProviderSession: startup.resumeProviderSession }
      : {})
  }
}

export function windowTabStartupParams(startup: TabStartup | undefined): Record<string, unknown> {
  if (!startup) {
    return {}
  }
  const openCode = openCodeModelStart(startup)
  if (openCode) {
    return openCode
  }
  const draftPaste = startupDraftPaste(startup)
  return {
    ...(startup.command ? { command: startup.command } : {}),
    ...(startup.startupCommandDelivery
      ? { startupCommandDelivery: startup.startupCommandDelivery }
      : {}),
    ...(startup.env ? { env: startup.env } : {}),
    ...(startup.envToDelete ? { envToDelete: startup.envToDelete } : {}),
    ...(startup.launchConfig ? { launchConfig: startup.launchConfig } : {}),
    ...(startup.resumeProviderSession
      ? { resumeProviderSession: startup.resumeProviderSession }
      : {}),
    ...(startup.launchToken ? { launchToken: startup.launchToken } : {}),
    ...(startup.launchAgent ? { launchAgent: startup.launchAgent } : {}),
    ...(startup.agentLaunch ? { agentLaunch: startup.agentLaunch } : {}),
    ...(startup.telemetry ? { telemetry: startup.telemetry } : {}),
    ...(draftPaste ? { draftPaste } : {})
  }
}

/**
 * Main runs this startup: the pane's own paste and status seed stand down, and a workspace
 * create's delayed draft delivery is fenced, so main's paste is the only one.
 */
export function handStartupToMain(
  worktreeId: string,
  tabId: string,
  paneKey: string,
  startup: TabStartup | undefined
): void {
  noteMainStartsPane(paneKey, {
    ...(startup?.initialAgentStatus ? { initialAgentStatus: startup.initialAgentStatus } : {}),
    ...(startup?.launchConfig ? { launchConfig: startup.launchConfig } : {}),
    ...(startup?.launchToken ? { launchToken: startup.launchToken } : {})
  })
  if (startup?.launchToken && startupDraftPaste(startup)) {
    markAgentStartupDeliveryConsumed(
      agentStartupDeliveryKey({ worktreeId, tabId, launchToken: startup.launchToken })
    )
  }
}

/** Main declined it: the pane starts its own terminal with this startup, as before. */
export function takeStartupBackFromMain(
  worktreeId: string,
  tabId: string,
  paneKey: string,
  startup: TabStartup | undefined
): void {
  forgetMainStartedPane(paneKey)
  if (startup?.launchToken && startupDraftPaste(startup)) {
    releaseAgentStartupDeliveryConsumed(
      agentStartupDeliveryKey({ worktreeId, tabId, launchToken: startup.launchToken })
    )
  }
}
