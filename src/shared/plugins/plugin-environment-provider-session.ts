import {
  pluginManagementRequestSchema,
  type PluginManagementRequest,
  type PluginManagementMethod,
  type PluginManagementResults
} from './plugin-management-api'
import { z } from 'zod'
import { environmentProviderRuntimeInputs } from './plugin-environment-provider-runtime-calls'
import { pluginChangeEventSchema, type PluginChangeEvent } from './plugin-change-event'
import type {
  EnvironmentProviderRuntimeMethod,
  EnvironmentProviderRuntimeInput,
  EnvironmentProviderRuntimeResults
} from './plugin-environment-provider-runtime-calls'

export const pluginEnvironmentProviderSessionOpenSchema = z.strictObject({
  purpose: z.enum(['providers', 'management']).optional(),
  sessionId: z.uuid(),
  environmentId: z.string().min(1).max(256),
  pairingRevision: z.number().int().nonnegative(),
  runtimeId: z.string().min(1).max(256)
})
export type PluginEnvironmentProviderSessionOpen = z.infer<
  typeof pluginEnvironmentProviderSessionOpenSchema
>
export const pluginEnvironmentProviderSessionCloseSchema = z.strictObject({ sessionId: z.uuid() })
export const pluginEnvironmentProviderSessionChangeSchema = z.strictObject({
  sessionId: z.uuid(),
  change: pluginChangeEventSchema
})

function call<Method extends EnvironmentProviderRuntimeMethod, Input extends z.ZodType>(
  method: Method,
  input: Input
) {
  return z.strictObject({ sessionId: z.uuid(), method: z.literal(method), input })
}
export const pluginEnvironmentProviderSessionCallSchema = z.discriminatedUnion('method', [
  call('list', environmentProviderRuntimeInputs.list.omit({ runtimeId: true })),
  call('listSaved', environmentProviderRuntimeInputs.listSaved.omit({ runtimeId: true })),
  call('configure', environmentProviderRuntimeInputs.configure.omit({ runtimeId: true })),
  call('snapshot', environmentProviderRuntimeInputs.snapshot.omit({ runtimeId: true })),
  call('savedSnapshot', environmentProviderRuntimeInputs.savedSnapshot.omit({ runtimeId: true })),
  call(
    'previousSnapshot',
    environmentProviderRuntimeInputs.previousSnapshot.omit({ runtimeId: true })
  ),
  call('execute', environmentProviderRuntimeInputs.execute.omit({ runtimeId: true })),
  call('recover', environmentProviderRuntimeInputs.recover.omit({ runtimeId: true })),
  call(
    'prepareMigration',
    environmentProviderRuntimeInputs.prepareMigration.omit({ runtimeId: true })
  ),
  call(
    'commitMigration',
    environmentProviderRuntimeInputs.commitMigration.omit({ runtimeId: true })
  ),
  call('prepareSsh', environmentProviderRuntimeInputs.prepareSsh.omit({ runtimeId: true })),
  call('saveSsh', environmentProviderRuntimeInputs.saveSsh.omit({ runtimeId: true })),
  call('discardSsh', environmentProviderRuntimeInputs.discardSsh.omit({ runtimeId: true })),
  call('cancel', environmentProviderRuntimeInputs.cancel.omit({ runtimeId: true }))
])

export const pluginManagementSessionCallSchema = z.strictObject({
  sessionId: z.uuid(),
  request: pluginManagementRequestSchema
})
export type PluginEnvironmentProviderSessionApi = {
  callPluginManagementSession?: <Method extends PluginManagementMethod>(input: {
    sessionId: string
    request: PluginManagementRequest
  }) => Promise<PluginManagementResults[Method]>
  openEnvironmentProviderSession?: (
    input: PluginEnvironmentProviderSessionOpen
  ) => Promise<{ sessionId: string; runtimeId: string }>
  callEnvironmentProviderSession?: <Method extends EnvironmentProviderRuntimeMethod>(input: {
    sessionId: string
    method: Method
    input: EnvironmentProviderRuntimeInput<Method>
  }) => Promise<EnvironmentProviderRuntimeResults[Method]>
  closeEnvironmentProviderSession?: (input: { sessionId: string }) => Promise<boolean>
  onEnvironmentProviderSessionRetired?: (
    callback: (input: { sessionId: string }) => void
  ) => () => void
  onEnvironmentProviderSessionChanged?: (
    callback: (input: { sessionId: string; change: PluginChangeEvent }) => void
  ) => () => void
}
