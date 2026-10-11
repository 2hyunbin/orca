import { useAppStore } from '@/store'
import type { SpawnDeferralReason } from '../../../../../shared/host-spawn-admission'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session-resume'
import { isResumableTuiAgent } from '../../../../../shared/agent-session-resume'
import { clearPaneSpawnDeferral, setPaneSpawnDeferral } from '../pane-spawn-deferral-registry'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import type {
  ColdRestoreAgentResumeStartup,
  FreshSpawnOptions,
  PendingStartupCommand
} from './fresh-spawn-types'

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
    // Why: the pane still exists, so only its own restore may consume the record, on open.
    origin: 'live',
    restoreOnTabOpenOnly: true
  }
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
      // Why left after a later resume: a live pane's `live` record is what periodic capture keeps too.
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
