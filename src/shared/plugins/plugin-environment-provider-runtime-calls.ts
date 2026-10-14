import type { z } from 'zod'
import * as input from './plugin-environment-provider-runtime-api'
import type { PluginEnvironmentProviderEntry } from './plugin-environment-provider-api'
import type { EnvironmentRecipeJournal } from './plugin-environment-recipe-journal'
import type { JournaledEnvironmentRecipeResult } from './plugin-environment-recipe-result'
import type { PluginEnvironmentProviderHistory } from './plugin-environment-provider-history-api'
import type {
  PluginEnvironmentProviderSavedEntry,
  PluginEnvironmentProviderSavedHistory
} from './plugin-environment-provider-saved-history-api'
import type { PluginEnvironmentProviderRecoveryResult } from './plugin-environment-provider-recovery-api'
import type { PluginEnvironmentProviderMigrationPreview } from './plugin-environment-provider-migration-api'
import type { EnvironmentProviderSshPreview } from './plugin-environment-provider-ssh-api'
import type { SshConnectionState, SshTarget } from '../ssh-types'

export const environmentProviderRuntimeInputs = {
  list: input.pluginEnvironmentProviderRuntimeListSchema,
  listSaved: input.pluginEnvironmentProviderRuntimeListSavedSchema,
  configure: input.pluginEnvironmentProviderRuntimeConfigureSchema,
  snapshot: input.pluginEnvironmentProviderRuntimeSnapshotSchema,
  savedSnapshot: input.pluginEnvironmentProviderRuntimeSavedSnapshotSchema,
  previousSnapshot: input.pluginEnvironmentProviderRuntimePreviousSnapshotSchema,
  execute: input.pluginEnvironmentProviderRuntimeExecuteSchema,
  recover: input.pluginEnvironmentProviderRuntimeRecoverSchema,
  prepareMigration: input.pluginEnvironmentProviderRuntimePrepareMigrationSchema,
  commitMigration: input.pluginEnvironmentProviderRuntimeCommitMigrationSchema,
  connectSsh: input.pluginEnvironmentProviderRuntimeConnectSshSchema,
  prepareSsh: input.pluginEnvironmentProviderRuntimePrepareSshSchema,
  saveSsh: input.pluginEnvironmentProviderRuntimeSaveSshSchema,
  discardSsh: input.pluginEnvironmentProviderRuntimeDiscardSshSchema,
  cancel: input.pluginEnvironmentProviderRuntimeCancelSchema
}

export type EnvironmentProviderRuntimeResults = {
  list: PluginEnvironmentProviderEntry[]
  listSaved: PluginEnvironmentProviderSavedEntry[]
  configure: PluginEnvironmentProviderEntry[]
  snapshot: EnvironmentRecipeJournal
  savedSnapshot: PluginEnvironmentProviderSavedHistory
  previousSnapshot: PluginEnvironmentProviderHistory
  execute: JournaledEnvironmentRecipeResult
  recover: PluginEnvironmentProviderRecoveryResult
  prepareMigration: PluginEnvironmentProviderMigrationPreview
  commitMigration: PluginEnvironmentProviderEntry[]
  connectSsh: SshConnectionState | null
  prepareSsh: EnvironmentProviderSshPreview
  saveSsh: SshTarget
  discardSsh: boolean
  cancel: boolean
}

export type EnvironmentProviderRuntimeMethod = keyof EnvironmentProviderRuntimeResults
export type EnvironmentProviderRuntimeInput<Method extends EnvironmentProviderRuntimeMethod> = Omit<
  z.input<(typeof environmentProviderRuntimeInputs)[Method]>,
  'runtimeId'
>
