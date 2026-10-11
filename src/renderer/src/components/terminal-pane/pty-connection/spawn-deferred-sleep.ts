import { useAppStore } from '@/store'
import { writeTerminalOutput } from '@/lib/pane-manager/pane-terminal-output-scheduler'
import type { SpawnDeferralReason } from '../../../../../shared/host-spawn-admission'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session-resume'
import {
  agentProviderSessionsEqual,
  isResumableTuiAgent
} from '../../../../../shared/agent-session-resume'
import { parsePaneKey } from '../../../../../shared/stable-pane-id'
import { stablePaneHasLivePty } from '@/lib/sleeping-agent-pane-ownership'
import { clearPaneSpawnDeferral, setPaneSpawnDeferral } from '@/lib/pane-spawn-deferral-registry'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import type {
  ColdRestoreAgentResumeStartup,
  FreshSpawnOptions,
  PendingStartupCommand
} from './fresh-spawn-types'

const SESSION_RUNNING_ELSEWHERE_NOTICE =
  '\r\n\x1b[2mThis agent session is already running in another tab.\x1b[0m\r\n'

type DeferredSpawn = {
  startupOverride: PendingStartupCommand | null | undefined
  options: FreshSpawnOptions
}

function isColdRestoreStartup(
  startup: PendingStartupCommand | null | undefined
): startup is ColdRestoreAgentResumeStartup {
  return Boolean(startup && 'launchConfig' in startup && 'resumeProviderSession' in startup)
}

/** The record a deferred restore leaves behind, so the session stays listed and resumable even if
 *  this pane goes away before the user opens it. */
function deferredResumeRecord(
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
    prompt: '',
    state: 'done',
    capturedAt: now,
    updatedAt: now,
    ...(typeof session.connectionId === 'string' ? { connectionId: session.connectionId } : {}),
    ...(launchConfig ? { launchConfig } : {}),
    // Why `quit`: like a quit capture it names a pane that still exists and is unfinished work,
    // so a sweep never discards it as passive history (a `live` done note is).
    origin: 'quit',
    restoreOnTabOpenOnly: true
  }
}

function providerSessionLiveInAnotherPane(resume: SleepingAgentSessionRecord): boolean {
  const state = useAppStore.getState()
  return Object.values(state.agentStatusByPaneKey).some((entry) => {
    const pane = entry.paneKey === resume.paneKey ? null : parsePaneKey(entry.paneKey)
    return (
      pane !== null &&
      entry.agentType === resume.agent &&
      agentProviderSessionsEqual(resume.agent, entry.providerSession, resume.providerSession) &&
      stablePaneHasLivePty(
        pane.tabId,
        pane.leafId,
        state.ptyIdsByTabId,
        state.terminalLayoutsByTabId[pane.tabId]
      )
    )
  })
}

/** A restore the host kept asleep: the pane shows a sleeping overlay and retries when opened. */
export function installSpawnDeferredSleep(session: ConnectPanePtySession): void {
  // Set by the transport for the spawn in flight; read when that spawn settles without a PTY.
  session.pendingSpawnDeferral = null
  session.deferredSpawn = null

  session.enterSpawnDeferredSleep = (
    reason: SpawnDeferralReason,
    startupOverride: PendingStartupCommand | null | undefined,
    options: FreshSpawnOptions,
    visibleAtSpawn: boolean
  ): void => {
    const record = deferredResumeRecord(session, startupOverride)
    if (record) {
      // Why left after a later resume: the next quit capture replaces it, and a pane with a live PTY owns it.
      useAppStore.getState().rememberSleepingAgentSession(record)
    }
    session.deferredSpawn = { startupOverride, options }
    setPaneSpawnDeferral(session.cacheKey, {
      reason,
      resume: () => void session.resumeDeferredSpawn()
    })
    if (!visibleAtSpawn) {
      // Why: a pane opened while its hidden restore was in flight resumes as the user's own.
      queueMicrotask(() => session.resumeDeferredSpawnOnReveal())
    }
  }

  session.resumeDeferredSpawn = (): Promise<string | null> => {
    const deferred: DeferredSpawn | null = session.deferredSpawn
    if (!deferred || session.disposed || session.transport.getPtyId()) {
      return Promise.resolve(null)
    }
    session.deferredSpawn = null
    clearPaneSpawnDeferral(session.cacheKey)
    const resume = deferredResumeRecord(session, deferred.startupOverride)
    if (resume && providerSessionLiveInAnotherPane(resume)) {
      // Why no spawn: the session already runs elsewhere, and a second `--resume` forks it.
      writeTerminalOutput(session.pane.terminal, SESSION_RUNNING_ELSEWHERE_NOTICE, {
        foreground: session.deps.isVisibleRef.current === true
      })
      return Promise.resolve(null)
    }
    return session.startFreshSpawn(deferred.startupOverride, deferred.options)
  }

  session.resumeDeferredSpawnOnReveal = (): void => {
    if (session.deferredSpawn && session.deps.isVisibleRef.current) {
      void session.resumeDeferredSpawn()
    }
  }

  session.disposeSpawnDeferral = (): void => {
    session.deferredSpawn = null
    clearPaneSpawnDeferral(session.cacheKey)
  }
}
