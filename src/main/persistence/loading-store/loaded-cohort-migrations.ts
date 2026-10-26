import { createHash, randomInt, randomUUID } from 'node:crypto'
import type { PersistedState } from '../../../shared/persisted-state-types'
import {
  createNewProfileNativeChatUpgradeTipAudience,
  parseNativeChatUpgradeTipAudience,
  type NativeChatUpgradeTipAudience
} from '../../../shared/native-chat-upgrade-tip-audience'
import { savedChatUiWithTerminalDefaultView } from '../applying-settings/terminal-settings-migrations'

import type { StoreRuntimeState } from './store-runtime-state'

type LoadedCohortMigrationOperationsRuntime = Pick<StoreRuntimeState, 'loadNeedsSave'>

export class LoadedCohortMigrationOperations {
  constructor(private readonly runtime: LoadedCohortMigrationOperationsRuntime) {}

  migrateTabSwitchKeybindings(state: PersistedState, fileExistedOnLoad: boolean): PersistedState {
    const existing = state.settings?.tabSwitchKeybindingSeed
    if (existing === 'pending' || existing === 'done') {
      return state
    }
    // Persist the frozen cohort before the first file makes a fresh install appear existing.
    this.runtime.loadNeedsSave = true
    return {
      ...state,
      settings: {
        ...state.settings,
        // Existing installs seed old chords; fresh ones use current defaults.
        tabSwitchKeybindingSeed: fileExistedOnLoad ? 'pending' : 'done'
      }
    }
  }

  captureNativeChatUpgradeTipAudience(savedProfile: unknown): NativeChatUpgradeTipAudience {
    const saved = isRecord(savedProfile) ? savedProfile.nativeChatUpgradeTipAudience : undefined
    const kept = saved === undefined ? null : parseNativeChatUpgradeTipAudience(saved)
    if (kept) {
      return kept
    }
    // Persist this decision before later settings changes can alter the apparent audience.
    this.runtime.loadNeedsSave = true
    if (!isRecord(savedProfile)) {
      return createNewProfileNativeChatUpgradeTipAudience()
    }
    if (saved !== undefined) {
      // Never rederive a damaged audience record from current Chat UI settings.
      return { version: 1, membership: 'excluded', basis: 'unreadable-record' }
    }
    const settings = isRecord(savedProfile.settings) ? savedProfile.settings : undefined
    const chatUi = settings?.experimentalNativeChat
    if (chatUi === true) {
      // The retired key proves the opt-in predates the upgrade; later opt-ins cannot establish membership.
      if (!settings || !Object.hasOwn(settings, 'openAgentTabsInChatByDefault')) {
        return { version: 1, membership: 'excluded', basis: 'chat-ui-on-unproven' }
      }
      return {
        version: 1,
        membership: 'eligible',
        basis: savedChatUiWithTerminalDefaultView(settings)
          ? 'chat-ui-on-terminal-default'
          : 'chat-ui-on'
      }
    }
    return {
      version: 1,
      membership: 'excluded',
      basis: chatUi === false ? 'chat-ui-off' : 'chat-ui-unset'
    }
  }

  // Assign once per profile; the file's prior existence decides which population's experiment it joins.
  assignWorkspaceDiscoveryCohort(
    state: PersistedState,
    fileExistedOnLoad: boolean
  ): PersistedState {
    const telemetry = state.settings?.telemetry
    if (
      !telemetry?.installId ||
      telemetry.workspaceDiscoveryNewUserCohort ||
      telemetry.workspaceDiscoveryExistingUserCohort
    ) {
      return state
    }
    this.runtime.loadNeedsSave = true
    const cohort = drawWorkspaceDiscoveryCohort(telemetry.installId)
    return {
      ...state,
      settings: {
        ...state.settings,
        telemetry: {
          ...telemetry,
          ...(fileExistedOnLoad
            ? { workspaceDiscoveryExistingUserCohort: cohort }
            : { workspaceDiscoveryNewUserCohort: cohort })
        }
      }
    }
  }

  migrateTelemetry(state: PersistedState, fileExistedOnLoad: boolean): PersistedState {
    const existing = state.settings?.telemetry
    // Partial telemetry blocks still require migration unless all invariants hold.
    if (
      typeof existing?.existedBeforeTelemetryRelease === 'boolean' &&
      typeof existing.installId === 'string' &&
      existing.installId.length > 0 &&
      (existing.optedIn === true || existing.optedIn === false || existing.optedIn === null)
    ) {
      return state
    }
    // Resolve cohort once so partial new-user state cannot change its default mid-migration.
    const resolvedExistedBefore =
      typeof existing?.existedBeforeTelemetryRelease === 'boolean'
        ? existing.existedBeforeTelemetryRelease
        : fileExistedOnLoad
    const onboardingLanguageCohort = !fileExistedOnLoad
      ? randomInt(2) === 0
        ? 'control'
        : 'treatment'
      : undefined
    this.runtime.loadNeedsSave = true
    return {
      ...state,
      settings: {
        ...state.settings,
        telemetry: {
          ...existing,
          ...(onboardingLanguageCohort ? { onboardingLanguageCohort } : {}),
          existedBeforeTelemetryRelease: resolvedExistedBefore,
          // Preserve explicit true, false and null; only absence uses the cohort default.
          optedIn:
            existing?.optedIn === true || existing?.optedIn === false || existing?.optedIn === null
              ? existing.optedIn
              : resolvedExistedBefore
                ? null
                : true,
          installId:
            typeof existing?.installId === 'string' && existing.installId.length > 0
              ? existing.installId
              : randomUUID()
        }
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 20% keep the pre-experiment handoff as control; 80% get the new one. */
export function drawWorkspaceDiscoveryCohort(installId: string): 'control' | 'treatment' {
  // A salted hash of the random install ID is as random as a fresh draw, reproducible from the
  // transmitted install_id, and independent of the language experiment's draw.
  const bucket = createHash('sha256')
    .update(`workspace_discovery:${installId}`)
    .digest()
    .readUInt32BE(0)
  return bucket % 5 === 0 ? 'control' : 'treatment'
}
