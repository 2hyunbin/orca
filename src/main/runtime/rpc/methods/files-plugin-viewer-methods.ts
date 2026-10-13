import { randomUUID } from 'node:crypto'
import { defineMethod, defineStreamingMethod, type RpcContext } from '../core'
import { PluginViewerDocumentError } from '../../../../shared/plugins/plugin-viewer-document'
import {
  PLUGIN_VIEWER_RUNTIME_DOCUMENT_CAPABILITY,
  PLUGIN_VIEWER_RUNTIME_SELECTION_CAPABILITY,
  pluginViewerRuntimeLeaseSchema,
  pluginViewerRuntimeOpenSchema,
  pluginViewerRuntimeReadSchema,
  pluginViewerRuntimeSelectionSchema
} from '../../../../shared/plugins/plugin-viewer-runtime-document'
import type { RuntimeViewerTransport } from '../../runtime-plugin-viewer-documents'

function transport(context: RpcContext): RuntimeViewerTransport {
  if (
    context.clientKind !== 'runtime' ||
    !context.connectionId ||
    !context.clientId ||
    !context.signal ||
    !context.clientCapabilities?.includes(PLUGIN_VIEWER_RUNTIME_DOCUMENT_CAPABILITY)
  ) {
    throw new PluginViewerDocumentError('unauthorized')
  }
  const connectionId = context.connectionId
  return {
    connectionId,
    clientId: context.clientId,
    signal: context.signal,
    registerCleanup: (cleanup) =>
      context.runtime.registerOwnedSubscriptionCleanup(
        `plugin-viewer:${randomUUID()}`,
        cleanup,
        connectionId
      ).releaseIfCurrent
  }
}

export const FILE_PLUGIN_VIEWER_METHODS = [
  defineMethod({
    name: 'files.pluginViewer.select',
    permission: 'host-admin',
    params: pluginViewerRuntimeSelectionSchema,
    handler: (params, context) => {
      if (!context.clientCapabilities?.includes(PLUGIN_VIEWER_RUNTIME_SELECTION_CAPABILITY)) {
        throw new PluginViewerDocumentError('unauthorized')
      }
      return context.runtime.selectRuntimePluginViewerFile(params, transport(context))
    }
  }),
  defineStreamingMethod({
    name: 'files.pluginViewer.observe',
    permission: 'workspace',
    params: pluginViewerRuntimeLeaseSchema,
    handler: (params, context, emit) =>
      context.runtime.observeRuntimePluginViewerDocument(params, transport(context), emit)
  }),
  defineMethod({
    name: 'files.pluginViewer.open',
    permission: 'workspace',
    params: pluginViewerRuntimeOpenSchema,
    handler: (params, context) =>
      context.runtime.openRuntimePluginViewerDocument(params, transport(context))
  }),
  defineMethod({
    name: 'files.pluginViewer.read',
    permission: 'workspace',
    params: pluginViewerRuntimeReadSchema,
    handler: (params, context) =>
      context.runtime.readRuntimePluginViewerDocument(params, transport(context))
  }),
  defineMethod({
    name: 'files.pluginViewer.close',
    permission: 'workspace',
    params: pluginViewerRuntimeLeaseSchema,
    handler: (params, context) =>
      context.runtime.closeRuntimePluginViewerDocument(params, transport(context))
  })
]
