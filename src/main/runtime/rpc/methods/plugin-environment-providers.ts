import { defineMethod, type RpcContext } from '../core'
import { PLUGIN_ENVIRONMENT_PROVIDER_RUNTIME_CAPABILITY } from '../../../../shared/plugins/plugin-environment-provider-runtime-capability'
import { requireEnvironmentProviderRpcController } from './plugin-environment-provider-service'
import {
  pluginEnvironmentProviderRuntimeListSchema,
  pluginEnvironmentProviderRuntimeListSavedSchema,
  pluginEnvironmentProviderRuntimeConfigureSchema,
  pluginEnvironmentProviderRuntimeSnapshotSchema,
  pluginEnvironmentProviderRuntimeSavedSnapshotSchema,
  pluginEnvironmentProviderRuntimePreviousSnapshotSchema,
  pluginEnvironmentProviderRuntimeExecuteSchema,
  pluginEnvironmentProviderRuntimeRecoverSchema,
  pluginEnvironmentProviderRuntimePrepareMigrationSchema,
  pluginEnvironmentProviderRuntimeCommitMigrationSchema,
  pluginEnvironmentProviderRuntimePrepareSshSchema,
  pluginEnvironmentProviderRuntimeSaveSshSchema,
  pluginEnvironmentProviderRuntimeDiscardSshSchema,
  pluginEnvironmentProviderRuntimeCancelSchema
} from '../../../../shared/plugins/plugin-environment-provider-runtime-api'

function owner(context: RpcContext, runtimeId: string) {
  if (
    context.clientKind !== 'runtime' ||
    !context.connectionId ||
    !context.clientId ||
    !context.signal ||
    !context.clientCapabilities?.includes(PLUGIN_ENVIRONMENT_PROVIDER_RUNTIME_CAPABILITY)
  ) {
    throw new Error('Environment providers require a negotiated paired control-host connection')
  }
  if (runtimeId !== context.runtime.getRuntimeId()) {
    throw new Error('Environment review belongs to another control host or server instance')
  }
  const key = `runtime:${context.connectionId}`
  requireEnvironmentProviderRpcController().bindOwnerSignal(key, context.signal)
  return { key, signal: context.signal }
}

export const PLUGIN_ENVIRONMENT_PROVIDER_METHODS = [
  defineMethod({
    name: 'plugins.environments.list',
    permission: 'host-admin',
    params: pluginEnvironmentProviderRuntimeListSchema,
    handler: (params, context) => {
      owner(context, params.runtimeId)
      return requireEnvironmentProviderRpcController().list()
    }
  }),
  defineMethod({
    name: 'plugins.environments.listSaved',
    permission: 'host-admin',
    params: pluginEnvironmentProviderRuntimeListSavedSchema,
    handler: (params, context) => {
      owner(context, params.runtimeId)
      return requireEnvironmentProviderRpcController().listSaved()
    }
  }),
  defineMethod({
    name: 'plugins.environments.configure',
    permission: 'host-admin',
    params: pluginEnvironmentProviderRuntimeConfigureSchema,
    handler: (params, context) => {
      owner(context, params.runtimeId)
      return requireEnvironmentProviderRpcController().configure(params.input)
    }
  }),
  defineMethod({
    name: 'plugins.environments.snapshot',
    permission: 'host-admin',
    params: pluginEnvironmentProviderRuntimeSnapshotSchema,
    handler: (params, context) => {
      owner(context, params.runtimeId)
      return requireEnvironmentProviderRpcController().snapshot(params.input)
    }
  }),
  defineMethod({
    name: 'plugins.environments.savedSnapshot',
    permission: 'host-admin',
    params: pluginEnvironmentProviderRuntimeSavedSnapshotSchema,
    handler: (params, context) => {
      owner(context, params.runtimeId)
      return requireEnvironmentProviderRpcController().savedSnapshot(params.input)
    }
  }),
  defineMethod({
    name: 'plugins.environments.previousSnapshot',
    permission: 'host-admin',
    params: pluginEnvironmentProviderRuntimePreviousSnapshotSchema,
    handler: (params, context) => {
      owner(context, params.runtimeId)
      return requireEnvironmentProviderRpcController().previousSnapshot(params.input)
    }
  }),
  defineMethod({
    name: 'plugins.environments.execute',
    permission: 'host-admin',
    params: pluginEnvironmentProviderRuntimeExecuteSchema,
    handler: (params, context) => {
      const requestOwner = owner(context, params.runtimeId)
      return requireEnvironmentProviderRpcController().execute(requestOwner, params.input)
    }
  }),
  defineMethod({
    name: 'plugins.environments.recover',
    permission: 'host-admin',
    params: pluginEnvironmentProviderRuntimeRecoverSchema,
    handler: (params, context) => {
      const requestOwner = owner(context, params.runtimeId)
      return requireEnvironmentProviderRpcController().recover(requestOwner, params.input)
    }
  }),
  defineMethod({
    name: 'plugins.environments.prepareMigration',
    permission: 'host-admin',
    params: pluginEnvironmentProviderRuntimePrepareMigrationSchema,
    handler: (params, context) => {
      const requestOwner = owner(context, params.runtimeId)
      return requireEnvironmentProviderRpcController().prepareMigration(requestOwner, params.input)
    }
  }),
  defineMethod({
    name: 'plugins.environments.commitMigration',
    permission: 'host-admin',
    params: pluginEnvironmentProviderRuntimeCommitMigrationSchema,
    handler: (params, context) => {
      const requestOwner = owner(context, params.runtimeId)
      return requireEnvironmentProviderRpcController().commitMigration(requestOwner, params.input)
    }
  }),
  defineMethod({
    name: 'plugins.environments.prepareSsh',
    permission: 'host-admin',
    params: pluginEnvironmentProviderRuntimePrepareSshSchema,
    handler: (params, context) => {
      const requestOwner = owner(context, params.runtimeId)
      return requireEnvironmentProviderRpcController().prepareSsh(requestOwner, params.input)
    }
  }),
  defineMethod({
    name: 'plugins.environments.saveSsh',
    permission: 'host-admin',
    params: pluginEnvironmentProviderRuntimeSaveSshSchema,
    handler: (params, context) => {
      const requestOwner = owner(context, params.runtimeId)
      return requireEnvironmentProviderRpcController().saveSsh(requestOwner, params.input)
    }
  }),
  defineMethod({
    name: 'plugins.environments.discardSsh',
    permission: 'host-admin',
    params: pluginEnvironmentProviderRuntimeDiscardSshSchema,
    handler: (params, context) => {
      const requestOwner = owner(context, params.runtimeId)
      return requireEnvironmentProviderRpcController().discardSsh(requestOwner, params.input)
    }
  }),
  defineMethod({
    name: 'plugins.environments.cancel',
    permission: 'host-admin',
    params: pluginEnvironmentProviderRuntimeCancelSchema,
    handler: (params, context) => {
      const requestOwner = owner(context, params.runtimeId)
      return requireEnvironmentProviderRpcController().cancel(requestOwner.key, params.input)
    }
  })
]
