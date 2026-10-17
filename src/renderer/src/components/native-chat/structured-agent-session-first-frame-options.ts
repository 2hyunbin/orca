import type { AgentSessionOptionCatalog } from '../../../../shared/agent-session-option-catalog'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { structuredAgentSessionSeedCatalog } from '../../../../shared/structured-agent-session-seed-catalog'
import {
  applyStructuredAgentSessionModelCatalog,
  createStructuredAgentSessionOptionState,
  type StructuredAgentSessionOptionState
} from '../../../../shared/structured-agent-session-options'
import { structuredAgentSessionOptionView } from '../../../../shared/structured-agent-session-option-view'
import { readHostModelCatalogSnapshot } from '@/runtime/host-model-catalog-snapshots'

/** The first frame: the host's saved list when the renderer already holds it, else the seed,
 *  which shows the quiet placeholder until the host answers. */
export function firstFrameOptionState(
  agent: AgentType,
  target: RuntimeClientTarget,
  launch: { newLaunch: boolean; worktree?: string; seedsModel: boolean }
): StructuredAgentSessionOptionState {
  const seed = structuredAgentSessionSeedCatalog(agent)
  const seeded = createStructuredAgentSessionOptionState(agent, seed)
  const snapshot = readHostModelCatalogSnapshot(target, agent, launch)
  return snapshot ? applyStructuredAgentSessionModelCatalog(seeded, seed, snapshot, launch) : seeded
}

export function structuredAgentSessionConfiguredOptionView(
  args: {
    agent: AgentType
    target: RuntimeClientTarget
    optionCatalog: AgentSessionOptionCatalog | null
    newLaunch: boolean
    worktree?: string
    seedsModel: boolean
    hostSelection: Readonly<Record<string, string>> | undefined
    hostPermissionMode?: string
    launchSeedOptions: Readonly<Record<string, string>> | undefined
    held: Readonly<Record<string, string>>
  },
  optionState: StructuredAgentSessionOptionState,
  takesSendOptions: boolean,
  currentIdentity: boolean
): StructuredAgentSessionOptionState {
  const {
    agent,
    target,
    optionCatalog,
    newLaunch,
    worktree,
    seedsModel,
    hostSelection,
    hostPermissionMode,
    launchSeedOptions,
    held
  } = args
  const selectionFromStatus = hostSelection !== undefined
  const configured = readHostModelCatalogSnapshot(target, agent, {
    newLaunch,
    worktree,
    seedsModel
  })
  // Live rows supply choices; the latest scoped host answer supplies the launch default.
  const scoped =
    configured && optionCatalog
      ? applyStructuredAgentSessionModelCatalog(
          createStructuredAgentSessionOptionState(agent),
          optionCatalog,
          configured,
          { newLaunch }
        ).catalog
      : null
  const defaultModel = scoped?.defaultModelIsCliDefault
    ? scoped.models.find((model) => model.isDefault)
    : undefined
  const defaultEffort = defaultModel?.options.find((option) => option.id === 'effort')?.kind
  const catalog =
    optionState.catalog && selectionFromStatus && defaultModel
      ? {
          ...optionState.catalog,
          defaultModelIsCliDefault: defaultModel ? (true as const) : undefined,
          models: optionState.catalog.models.map((model) => ({
            ...model,
            isDefault: model.id === defaultModel?.id,
            options: model.options.map((option) =>
              model.id === defaultModel?.id &&
              option.id === 'effort' &&
              option.kind.type === 'select' &&
              defaultEffort?.type === 'select' &&
              defaultEffort.defaultIsCliDefault &&
              option.kind.choices.some((choice) => choice.value === defaultEffort.defaultValue)
                ? {
                    ...option,
                    kind: {
                      ...option.kind,
                      defaultValue: defaultEffort.defaultValue,
                      defaultIsCliDefault: true as const
                    }
                  }
                : option
            )
          }))
        }
      : optionState.catalog
  return structuredAgentSessionOptionView(
    {
      ...optionState,
      catalog,
      executionUnknown:
        !optionState.record.model &&
        !hostSelection?.model &&
        !launchSeedOptions?.model &&
        !held.model &&
        !optionState.pendingPick &&
        !catalog?.defaultModelIsCliDefault,
      pendingPick: currentIdentity ? optionState.pendingPick : null
    },
    selectionFromStatus ? undefined : launchSeedOptions,
    held,
    takesSendOptions,
    { selection: hostSelection, permissionMode: hostPermissionMode }
  )
}
