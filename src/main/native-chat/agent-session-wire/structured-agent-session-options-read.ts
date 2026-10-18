import { providerChildRootExited } from './structured-agent-session-provider-child'
// A chat's options, live or at rest.
//
// At rest nothing here needs a child. The pick is the record's own `options` — what the next start replays —
// and the list is the host's model catalog, the same one the picker already reads before a chat
// exists. A pick made at rest is written to the record as intent, through the same transition a live
// pick takes, so the next start applies it.

import type {
  AgentSessionModelCatalogResult,
  AgentSessionOptionsResult
} from '../../../shared/agent-session-wire'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type {
  AgentJournalCursor,
  AgentJournalThreadGoal
} from '../../../shared/agent-session-journal-types'
import { decodeStructuredAgentSessionOptionValue } from '../../../shared/structured-agent-session-option-codec'
import { journalOpenReadRefusal } from '../agent-session-journal/journal-open-failure'
import type { StructuredAgentDefinition } from './structured-agent-definition'
import type { StructuredAgentRegistry } from './structured-agent-registry'
import type { StructuredAgentSessionLiveOptions } from './structured-agent-session-adapter'
import { retainedAgentModelCatalogModels } from '../agent-model-catalog/agent-model-catalog-entry'
import { saveStructuredAgentSessionListing } from './structured-agent-session-start-listing'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import {
  structuredAgentSessionCurrentModelOptions,
  structuredAgentSessionOptionModels
} from './structured-agent-session-option-models'
import { structuredAgentSessionLaunchPermission } from './structured-agent-session-launch-permission'
export {
  recordStructuredAgentSessionOptionIntent,
  structuredAgentSessionOptionOverridesRefusal
} from './structured-agent-session-option-intent'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'

type RestingOptions = Pick<
  AgentSessionOptionsResult,
  'models' | 'listedModelIds' | 'fastModeSupport' | 'current'
>

/** What the asking client takes: whether it reads an answer that names no model. */
export type StructuredAgentSessionOptionsReader = {
  readsWithoutModel: boolean
  readsCoherentCatalog?: boolean
}

/** A same-build caller in this process reads as the RPC gate treats one: it takes no model. */
export const IN_PROCESS_OPTIONS_READER: StructuredAgentSessionOptionsReader = {
  readsWithoutModel: true,
  readsCoherentCatalog: true
}

/** The at-rest rules of the record's agent, as this runtime registered it; null for any other. */
function restingOptionRules(
  agents: Pick<StructuredAgentRegistry, 'definition'>,
  record: AgentSessionRecord
): StructuredAgentDefinition['restingOptions'] | null {
  return agents.definition(record.provider)?.restingOptions ?? null
}

async function readStructuredAgentSessionOptionsAtRest(
  deps: Pick<StructuredAgentSessionHostDeps, 'store' | 'agents' | 'modelCatalog'>,
  sessionId: string,
  reader: StructuredAgentSessionOptionsReader
): Promise<RestingOptions> {
  const record = deps.store.getRecord(sessionId)
  if (!record) {
    throw new Error('agent_session_identity_required')
  }
  const rules = restingOptionRules(deps.agents, record)
  const readCatalog = async (
    inSessionWorkspace: boolean
  ): Promise<AgentSessionModelCatalogResult> =>
    (await deps.modelCatalog
      ?.read({
        agent: record.provider,
        sessionId,
        ...(reader.readsCoherentCatalog ? {} : { savedOnly: true }),
        legacy: !reader.readsCoherentCatalog,
        ...(inSessionWorkspace
          ? { inSessionWorkspace: true as const }
          : { accountDefault: true as const })
      })
      .catch(() => null)) ?? { origin: 'unknown' }
  // The chat's own folder decides its default, as its first frame did.
  const scoped = await readCatalog(true)
  const folderDefault =
    scoped.origin === 'unknown' ? undefined : scoped.models.find((entry) => entry.isDefault)
  // Where the folder names none, a client that needs a model keeps the account default it got before.
  const catalog =
    deps.store.getRecord(sessionId)?.options?.model === undefined &&
    !folderDefault &&
    scoped.origin !== 'unknown' &&
    !reader.readsWithoutModel
      ? await readCatalog(false)
      : scoped
  const saved = deps.store.getRecord(sessionId)?.options ?? {}
  // With no catalog for the account, the list a running child of this agent falls back to.
  const discoveryOnly = record.provider === 'claude' || record.provider === 'codex'
  const listed =
    catalog.origin === 'unknown'
      ? discoveryOnly
        ? null
        : (rules?.fallbackModels() ?? null)
      : catalog.models
  const models = listed ?? []
  const fastMode =
    saved.fastMode === undefined
      ? null
      : decodeStructuredAgentSessionOptionValue('fastMode', saved.fastMode)
  // An unknown model is one the client already treats as unconfirmed. Only a real listing names the
  // account's default; a built-in list's default is a guess, so with none the client keeps its own.
  const model =
    saved.model ??
    (reader.readsCoherentCatalog || catalog.origin === 'unknown'
      ? undefined
      : models.find((entry) => entry.isDefault)?.id)
  // The pick, else the model's default where a live child reports that, or where the chat's folder
  // names that model as what it runs, as its first frame showed.
  const effort =
    saved.effort ??
    (rules?.effortDefaultsToModel || (saved.model === undefined && folderDefault)
      ? models.find((entry) => entry.id === model)?.defaultEffort
      : undefined)
  return {
    models: structuredAgentSessionOptionModels(models, model, (row) => row),
    listedModelIds:
      catalog.origin === 'unknown'
        ? []
        : structuredAgentSessionOptionModels(models, model, (row) => row).map((row) => row.id),
    ...(catalog.origin !== 'unknown' && catalog.fastModeSupport
      ? { fastModeSupport: catalog.fastModeSupport }
      : {}),
    current: {
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(typeof fastMode === 'boolean' ? { fastMode } : {}),
      ...(saved.serviceTier ? { serviceTier: saved.serviceTier } : {})
    }
  }
}

/** A live child's own answer, or the answer at rest; the goal, usage and rewind either way. */
export async function readStructuredAgentSessionOptions(
  context: Pick<
    StructuredAgentSessionMutationContext,
    'deps' | 'serialize' | 'openConversation' | 'conversation'
  >,
  sessionId: string,
  reader: StructuredAgentSessionOptionsReader
): Promise<AgentSessionOptionsResult> {
  const { adapter, agents, store } = context.deps
  const started = await context.serialize(sessionId, async () => {
    const session = await context.openConversation(sessionId).catch((error: unknown) => {
      throw journalOpenReadRefusal(error, context.deps.logger, sessionId)
    })
    const child = session?.child
    // A starting child is asked nothing: the answer is the saved intent and the catalog.
    if (!child || child.phase === 'starting' || providerChildRootExited(session)) {
      return { kind: 'rest' as const, child }
    }
    const prepared = adapter.prepareReadOptions?.({
      sessionId,
      fence: child.fence,
      legacyCatalog: !reader.readsCoherentCatalog
    })
    if (prepared) {
      return { kind: 'prepared' as const, child, prepared }
    }
    const readOptions = adapter.readOptions
    if (!readOptions) {
      throw new Error('structured_agent_session_options_unsupported')
    }
    if (agents.definition(session.params.provider)?.handleTransport === 'acp') {
      return {
        kind: 'acp' as const,
        child,
        read: () => readOptions.call(adapter, { sessionId, fence: child.fence })
      }
    }
    return {
      kind: 'live' as const,
      child,
      options: await readOptions.call(adapter, { sessionId, fence: child.fence })
    }
  })
  const live: StructuredAgentSessionLiveOptions | null =
    started.kind === 'live'
      ? started.options
      : started.kind === 'prepared'
        ? await started.prepared.then((apply) =>
            context.serialize(sessionId, async () => {
              const child = (await context.openConversation(sessionId))?.child
              return child === started.child ? apply() : null
            })
          )
        : null
  const inventory = await readStructuredAgentSessionOptionsAtRest(context.deps, sessionId, reader)
  const permissionRecord = store.getRecord(sessionId)
  // What a start launches now, live or at rest: a child never reports it.
  const permissionMode = permissionRecord
    ? await structuredAgentSessionLaunchPermission(context.deps, permissionRecord)
    : null
  const finish = () =>
    finishStructuredAgentSessionOptionsRead(
      context,
      sessionId,
      started.child,
      live,
      inventory,
      permissionMode,
      started.kind === 'acp' ? started.read : undefined
    )
  return started.kind === 'acp' ? context.serialize(sessionId, finish) : finish()
}

async function finishStructuredAgentSessionOptionsRead(
  context: Parameters<typeof readStructuredAgentSessionOptions>[0],
  sessionId: string,
  startedChild: StructuredAgentSessionHostSession['child'] | undefined,
  reported: StructuredAgentSessionLiveOptions | null,
  inventory: RestingOptions,
  permissionMode: Awaited<ReturnType<typeof structuredAgentSessionLaunchPermission>>,
  readAcp?: () => Promise<StructuredAgentSessionLiveOptions>
): Promise<AgentSessionOptionsResult> {
  const { adapter, agents, store } = context.deps
  // Reacquire after the last async read: a close/reopen can replace the whole handle.
  const session = await context.conversation(sessionId)
  const agent = session.params.provider
  const capabilities = agents.capabilities(agent)
  const floor = session.journal.context.floor()
  const contextFloor = floor ? { contextFloor: floor } : {}
  const discoveryOnly = agent === 'claude' || agent === 'codex'
  let live = reported
  // Child identity fences current facts only; discovery survives an exit or replacement.
  if (session.child !== startedChild || ((live || readAcp) && providerChildRootExited(session))) {
    live = null
  } else if (readAcp) {
    // ACP reports current configuration after async inventory reads, in the same ordered step.
    live = await readAcp()
  }
  const record = store.getRecord(sessionId)
  const phase = record?.rewind?.phase
  let options: Omit<AgentSessionOptionsResult, 'rewind'> = inventory
  if (live) {
    const { catalogListing, ...answer } = live
    options = discoveryOnly
      ? {
          ...inventory,
          ...answer,
          models: inventory.models,
          listedModelIds: inventory.listedModelIds
        }
      : answer
    if (!discoveryOnly && catalogListing) {
      const ids = context.deps.modelCatalog
        ? context.deps.modelCatalog.retainedLiveModelIds(sessionId, catalogListing)
        : retainedAgentModelCatalogModels(undefined, catalogListing).map((model) => model.id)
      saveStructuredAgentSessionListing(context, sessionId, catalogListing)
      options = { ...answer, listedModelIds: ids }
    }
  }
  const saved = live && readAcp ? undefined : record?.options
  const current = {
    ...options.current,
    ...(saved?.model !== undefined ? { model: saved.model } : {}),
    ...(saved?.effort !== undefined ? { effort: saved.effort } : {})
  }
  const confirmed = current.confirmed?.filter((key) =>
    key === 'model'
      ? current.model === options.current.model
      : key !== 'effort' || current.effort === options.current.effort
  )
  const result: AgentSessionOptionsResult = {
    ...options,
    current: {
      ...current,
      ...(confirmed ? { confirmed } : {}),
      ...(permissionMode ? { permissionMode } : {})
    },
    rewind:
      phase === 'prepared' || phase === 'provider-succeeded'
        ? { supported: false, reason: 'outcome-unknown' }
        : (adapter.rewindSupport?.(sessionId, agent) ?? {
            supported: false,
            reason: 'unsupported'
          }),
    conversationCommands: capabilities?.compact ? ['clear', 'compact'] : ['clear'],
    // A live child may narrow what its agent declares, never widen it.
    acceptsImages: capabilities?.imagePrompts === true && options.acceptsImages !== false,
    ...structuredAgentSessionThreadGoalReport(
      capabilities?.threadGoal === true,
      session.journal.threadGoal(),
      contextFloor
    ),
    ...(capabilities?.contextUsage
      ? { contextUsage: { current: session.journal.contextUsage(), ...contextFloor } }
      : {})
  }
  return structuredAgentSessionCurrentModelOptions(result, discoveryOnly ? live : null)
}

/** A goal the host can change, or one only the agent's own `/goal` changes, reported apart. */
function structuredAgentSessionThreadGoalReport(
  hostChangesGoal: boolean,
  current: AgentJournalThreadGoal | null,
  contextFloor: { contextFloor?: AgentJournalCursor }
): Pick<AgentSessionOptionsResult, 'threadGoal' | 'reportedThreadGoal'> {
  if (hostChangesGoal) {
    return { threadGoal: { current, ...contextFloor } }
  }
  return current ? { reportedThreadGoal: { current, ...contextFloor } } : {}
}
