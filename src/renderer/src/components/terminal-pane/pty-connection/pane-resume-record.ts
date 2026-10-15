import {
  isResumableTuiAgent,
  type SleepingAgentSessionRecord
} from '../../../../../shared/agent-session-resume'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import type { ColdRestoreAgentResumeStartup, PendingStartupCommand } from './fresh-spawn-types'

export function isColdRestoreStartup(
  startup: PendingStartupCommand | null | undefined
): startup is ColdRestoreAgentResumeStartup {
  return Boolean(startup && 'launchConfig' in startup && 'resumeProviderSession' in startup)
}

/** The record that keeps a pane's agent session listed and resumable when nothing else names it. */
export function paneResumeRecord(
  session: ConnectPanePtySession,
  startupOverride: PendingStartupCommand | null | undefined
): SleepingAgentSessionRecord | null {
  const coldRestore = isColdRestoreStartup(startupOverride) ? startupOverride : null
  const agent = coldRestore?.agent ?? session.paneStartup?.launchAgent
  const providerSession =
    coldRestore?.resumeProviderSession ?? session.paneStartup?.resumeProviderSession
  if (!agent || !isResumableTuiAgent(agent) || !providerSession) {
    return null
  }
  const launchConfig = coldRestore?.launchConfig ?? session.paneStartup?.launchConfig
  const now = Date.now()
  return {
    paneKey: session.cacheKey,
    tabId: session.deps.tabId,
    worktreeId: session.deps.worktreeId,
    agent,
    providerSession,
    ...(coldRestore?.connectionId !== undefined ? { connectionId: coldRestore.connectionId } : {}),
    prompt: '',
    state: 'done',
    capturedAt: now,
    updatedAt: now,
    ...(launchConfig ? { launchConfig } : {}),
    // Why `quit`: like a quit capture it names a pane that still exists and is unfinished work,
    // so a sweep never discards it as passive history (a `live` done note is).
    origin: 'quit',
    restoreOnTabOpenOnly: true
  }
}
