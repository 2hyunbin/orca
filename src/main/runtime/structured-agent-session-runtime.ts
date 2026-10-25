// Install lazily after Electron finalizes the profile path; runtimes without structured requests need no store. Journal-open failures install a refusal.

import { bindAtRestCommandContexts } from '../native-chat/agent-session-wire/at-rest-command-context'
import type { AgentSessionResumeTrigger } from '../../shared/agent-session-resume-marker'
import {
  structuredAgentSessionTeardownTrigger,
  tearDownRuntime,
  type InstalledRuntime
} from './agent-session/structured-agent-session-runtime-teardown'
import { AgentSessionRecoveryCapsule } from './agent-session-recovery-capsule'
import { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { StructuredAgentSessionAdapterRouter } from '../native-chat/agent-session-wire/structured-agent-session-adapter-router'
import { StructuredAgentRegistry } from '../native-chat/agent-session-wire/structured-agent-registry'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  installAgentSessionAttachments,
  stopAgentSessionAttachments
} from './structured-agent-session-attachment-wiring'
import {
  openAgentSessionRecordStoreOnce,
  releaseAgentSessionRecordStore,
  type OpenedAgentSessionRecordStore
} from './agent-session-record-store-slot'
import {
  createStructuredAgentSessionOwnerProbe,
  createStructuredAgentSessionOwnerProbes
} from './structured-agent-session-owner-probe'
import { createStructuredAgentEnvironmentResolvers } from './structured-agent-shell-environment'
import type { StructuredAgentAdapterContext } from './structured-agent-runtime-registration-types'
import { createStructuredAgentSessionLifecycleDelivery } from './structured-agent-session-lifecycle-delivery'
import { createStructuredAgentSessionDispatchFollowUps } from './structured-agent-session-dispatch-followups'
import { agentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import {
  neverThrowingStructuredAgentSessionLogger,
  type StructuredAgentSessionLogger
} from '../native-chat/agent-session-wire/structured-agent-session-logger'
import { modelCatalogHostDeps } from './structured-agent-model-catalog-wiring'
import { migrateLegacyNativeChatVisualsFolders } from '../native-chat/native-chat-scratch-folder-migration'
import { scheduleNativeChatVisualsSweep } from '../native-chat/native-chat-visuals-sweep'

export { hasPersistedStructuredAgentSessionStore } from './agent-session-record-store-slot'

export type { StructuredAgentSessionRuntimeDeps } from './structured-agent-session-runtime-contract'
import type { StructuredAgentSessionRuntimeDeps } from './structured-agent-session-runtime-contract'

let installing: Promise<InstalledRuntime> | null = null

export const CLAUDE_STRUCTURED_AUTH_POLICY_REQUIRED =
  'structured agent-session host requires a Claude auth policy resolver'

export const STRUCTURED_AGENT_LAUNCH_ARGS_REQUIRED =
  'structured agent-session host requires a launch arguments resolver'

export const STRUCTURED_AGENT_SESSION_LOGGER_REQUIRED =
  'structured agent-session host requires a logger'

/** Keep failed teardowns after clearing the install slot so later stops retry their indexed conversations and journal connection. */
const pendingTeardown = new Set<InstalledRuntime>()

export function ensureStructuredAgentSessionHost(
  deps: StructuredAgentSessionRuntimeDeps
): Promise<StructuredAgentSessionHost> {
  // A failed open must not poison the slot forever — the next call retries.
  installing ??= install(deps).catch((error) => {
    installing = null
    throw error
  })
  return installing.then((installed) => installed.host)
}

/** Wait until observed exits publish and host reconciliation settles; callbacks alone cannot tell callers when lease updates land. */
export async function waitForStructuredAgentSessionRecovery(): Promise<void> {
  const installed = await installing?.catch(() => null)
  await installed?.waitForRecovery()
}

/** Stop every provider child; retain failed teardowns for retry after the install slot clears. */
export async function stopStructuredAgentSessionRuntime(options?: {
  trigger?: AgentSessionResumeTrigger
}): Promise<void> {
  const trigger = options?.trigger ?? structuredAgentSessionTeardownTrigger()
  const pending = installing
  installing = null
  setStructuredAgentSessionHost(null)
  stopAgentSessionAttachments()
  const outstanding = [...pendingTeardown]
  pendingTeardown.clear()
  const installed = pending ? await pending.catch(() => null) : null
  if (installed) {
    outstanding.push(installed)
  }
  // A store admission opened with no host built on it has no teardown to close its database.
  const recordStore = await releaseAgentSessionRecordStore()
  if (
    recordStore &&
    !outstanding.some((runtime) => runtime.journalDatabase === recordStore.journalDatabase)
  ) {
    recordStore.journalDatabase.close()
  }
  const failures: unknown[] = []
  for (const runtime of outstanding) {
    try {
      await tearDownRuntime(runtime, trigger)
    } catch (error) {
      pendingTeardown.add(runtime)
      failures.push(error)
    }
  }
  await agentModelCatalogStore.flushPersistence()
  if (failures.length === 1) {
    throw failures[0]
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, 'structured agent-session runtime teardown failed')
  }
}

async function install(deps: StructuredAgentSessionRuntimeDeps): Promise<InstalledRuntime> {
  // A default policy could attribute sign-in failures to the wrong account.
  if (typeof deps.resolveClaudeAuthPolicy !== 'function') {
    throw new Error(CLAUDE_STRUCTURED_AUTH_POLICY_REQUIRED)
  }
  if (typeof deps.resolveLaunchArgs !== 'function') {
    throw new Error(STRUCTURED_AGENT_LAUNCH_ARGS_REQUIRED)
  }
  const declared: Partial<StructuredAgentSessionLogger> | undefined = deps.logger
  if (typeof declared?.warn !== 'function' || typeof declared.error !== 'function') {
    throw new Error(STRUCTURED_AGENT_SESSION_LOGGER_REQUIRED)
  }
  const logger = neverThrowingStructuredAgentSessionLogger(deps.logger)
  // The store launch admission may already have opened; a failed install leaves it to that slot.
  const recordStore = await openAgentSessionRecordStoreOnce({
    stateDirectory: deps.stateDirectory,
    hostId: deps.hostId,
    logger
  })
  try {
    // Without the Arguments source there is nothing to fill from; missing modes run Ask.
    if (deps.resolveAgentFullAccess) {
      await recordStore.store.backfillChatPermissionModes(deps.resolveAgentFullAccess)
    }
  } catch (error) {
    // Missing choices safely run Ask; the next host install retries this pass.
    logger.warn('saving existing chat permission choices failed', {
      scope: 'permission-mode-backfill',
      error
    })
  }
  // Before the host serves reads: a chat opened right after an update finds its visuals in place.
  await migrateLegacyNativeChatVisualsFolders(deps.stateDirectory, logger)
  return await installOnJournal({ ...deps, logger }, recordStore)
}

async function installOnJournal(
  deps: StructuredAgentSessionRuntimeDeps,
  { journalDatabase, store }: OpenedAgentSessionRecordStore
): Promise<InstalledRuntime> {
  const envResolvers = createStructuredAgentEnvironmentResolvers(deps)
  let host: StructuredAgentSessionHost | null = null
  const lifecycle = createStructuredAgentSessionLifecycleDelivery({
    handle: (event) => host?.handleAdapterEvent(event),
    logger: deps.logger,
    // An agent that publishes an observed exit only after its own close work drains it here.
    drainObservedExits: async () => {
      await Promise.all(
        registrations.map(({ adapter }) => adapter.drainObservedExits?.() ?? Promise.resolve())
      )
    }
  })
  const context: StructuredAgentAdapterContext = {
    deps,
    store,
    journalDatabase,
    environment: envResolvers,
    deliverLifecycle: lifecycle.deliver,
    followUps: createStructuredAgentSessionDispatchFollowUps({
      host: () => host,
      logger: deps.logger
    }),
    host: () => host
  }
  const { STRUCTURED_AGENT_RUNTIME_REGISTRATIONS } =
    await import('./structured-agent-runtime-registrations')
  const registrations = STRUCTURED_AGENT_RUNTIME_REGISTRATIONS.map(
    ({ definition, createAdapter }) => ({ definition, adapter: createAdapter(context) })
  )
  const agents = new StructuredAgentRegistry(registrations)
  const adapter = new StructuredAgentSessionAdapterRouter(agents, async () => {
    await Promise.all(registrations.map((registration) => registration.adapter.closeAll()))
  })
  host = new StructuredAgentSessionHost({
    store,
    adapter,
    agents,
    recoveryCapsule: new AgentSessionRecoveryCapsule(deps.stateDirectory),
    journalDatabase,
    claimKeyId: deps.claimKeyId,
    probeOwner: createStructuredAgentSessionOwnerProbe(deps.hostId),
    probeOwners: createStructuredAgentSessionOwnerProbes(deps.hostId),
    resolveWorkspacePath: deps.resolveWorkspacePath,
    logger: deps.logger,
    ...(deps.onRequestFailure ? { onRequestFailure: deps.onRequestFailure } : {}),
    ...(deps.onSessionStatusChanged ? { onSessionStatusChanged: deps.onSessionStatusChanged } : {}),
    ...(deps.statusSink ? { statusSink: deps.statusSink } : {}),
    ...(deps.conversationNaming ? { conversationNaming: deps.conversationNaming } : {}),
    ...(deps.hasOpenDispatch ? { hasOpenDispatch: deps.hasOpenDispatch } : {}),
    ...(deps.startupLimits ? { startupLimits: deps.startupLimits } : {}),
    ...(deps.onSessionTabHidden ? { onSessionTabHidden: deps.onSessionTabHidden } : {}),
    ...(deps.assertNoTerminalWriter ? { assertNoTerminalWriter: deps.assertNoTerminalWriter } : {}),
    ...(await modelCatalogHostDeps({
      store,
      agents,
      registrations: STRUCTURED_AGENT_RUNTIME_REGISTRATIONS,
      deps,
      environment: envResolvers
    }))
  })
  if (deps.attentionDelivery) {
    const installed = host
    const delivery = deps.attentionDelivery
    installed.subscribeTurnCompletions({
      id: 'host-attention-delivery',
      includePrompts: true,
      emit: (event) => {
        if (event.type === 'end') {
          return
        }
        const sessionId =
          event.type === 'prompt' ? event.prompt.sessionId : event.completion.sessionId
        delivery.deliver(event, installed.readStatusSummary(sessionId))
      },
      onState: delivery.reconcile
    })
  }
  // Prewarm catalogs at runtime start for local and remote hosts.
  const modelCatalog = host.deps.modelCatalog
  void modelCatalog?.prewarm()
  installAgentSessionAttachments({
    stateDirectory: deps.stateDirectory,
    store,
    journalDatabase,
    logger: deps.logger
  })
  const stopVisualsSweep = deps.nativeChatVisuals
    ? scheduleNativeChatVisualsSweep({
        stateDirectory: deps.stateDirectory,
        listHeldSessionIds: () => (store.readOnly ? null : store.listHeldSessionIds()),
        logger: deps.logger
      })
    : undefined
  const stopCommands = bindAtRestCommandContexts(
    registrations.map(({ adapter }) => adapter.atRestCommands)
  )
  const unbindEnvironment = envResolvers.bindCatalogSources(
    registrations.map(({ definition }) => definition.agent)
  )
  try {
    setStructuredAgentSessionHost(host)
  } catch (error) {
    unbindEnvironment()
    stopCommands()
    throw error
  }
  return {
    host,
    adapter,
    journalDatabase,
    waitForRecovery: lifecycle.drain,
    stopBackgroundWork: () => {
      unbindEnvironment()
      stopCommands()
      stopVisualsSweep?.()
      modelCatalog?.stop()
    }
  }
}
