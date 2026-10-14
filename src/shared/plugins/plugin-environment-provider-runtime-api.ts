import { z } from 'zod'
import {
  pluginEnvironmentProviderReviewSchema,
  pluginEnvironmentProviderExecuteSchema,
  pluginEnvironmentProviderCancelSchema
} from './plugin-environment-provider-api'
import { pluginEnvironmentProviderHistorySchema } from './plugin-environment-provider-history-api'
import { pluginEnvironmentProviderSavedHistorySchema } from './plugin-environment-provider-saved-history-api'
import { pluginEnvironmentProviderRecoverSchema } from './plugin-environment-provider-recovery-api'
import {
  pluginEnvironmentProviderMigrationPrepareSchema,
  pluginEnvironmentProviderMigrationCommitSchema
} from './plugin-environment-provider-migration-api'
import {
  pluginEnvironmentProviderSshConnectSchema,
  pluginEnvironmentProviderSshPrepareSchema,
  pluginEnvironmentProviderSshSaveSchema,
  pluginEnvironmentProviderSshDiscardSchema
} from './plugin-environment-provider-ssh-api'

const runtimeId = z.string().min(1).max(256)

export const pluginEnvironmentProviderRuntimeListSchema = z.strictObject({ runtimeId })
export const pluginEnvironmentProviderRuntimeListSavedSchema = z.strictObject({ runtimeId })
export const pluginEnvironmentProviderRuntimeConfigureSchema = z.strictObject({
  runtimeId,
  input: pluginEnvironmentProviderReviewSchema
})
export const pluginEnvironmentProviderRuntimeSnapshotSchema = z.strictObject({
  runtimeId,
  input: pluginEnvironmentProviderReviewSchema
})
export const pluginEnvironmentProviderRuntimeSavedSnapshotSchema = z.strictObject({
  runtimeId,
  input: pluginEnvironmentProviderSavedHistorySchema
})
export const pluginEnvironmentProviderRuntimePreviousSnapshotSchema = z.strictObject({
  runtimeId,
  input: pluginEnvironmentProviderHistorySchema
})
export const pluginEnvironmentProviderRuntimeExecuteSchema = z.strictObject({
  runtimeId,
  input: pluginEnvironmentProviderExecuteSchema
})
export const pluginEnvironmentProviderRuntimeRecoverSchema = z.strictObject({
  runtimeId,
  input: pluginEnvironmentProviderRecoverSchema
})
export const pluginEnvironmentProviderRuntimePrepareMigrationSchema = z.strictObject({
  runtimeId,
  input: pluginEnvironmentProviderMigrationPrepareSchema
})
export const pluginEnvironmentProviderRuntimeCommitMigrationSchema = z.strictObject({
  runtimeId,
  input: pluginEnvironmentProviderMigrationCommitSchema
})
export const pluginEnvironmentProviderRuntimePrepareSshSchema = z.strictObject({
  runtimeId,
  input: pluginEnvironmentProviderSshPrepareSchema
})
export const pluginEnvironmentProviderRuntimeSaveSshSchema = z.strictObject({
  runtimeId,
  input: pluginEnvironmentProviderSshSaveSchema
})
export const pluginEnvironmentProviderRuntimeDiscardSshSchema = z.strictObject({
  runtimeId,
  input: pluginEnvironmentProviderSshDiscardSchema
})
export const pluginEnvironmentProviderRuntimeCancelSchema = z.strictObject({
  runtimeId,
  input: pluginEnvironmentProviderCancelSchema
})

export const pluginEnvironmentProviderRuntimeConnectSshSchema = z.strictObject({
  runtimeId,
  input: pluginEnvironmentProviderSshConnectSchema
})
