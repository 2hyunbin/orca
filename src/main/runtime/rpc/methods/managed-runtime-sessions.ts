import {
  ManagedRuntimeSessionOpenSchema,
  ManagedRuntimeSessionSelectorSchema
} from '../../../../shared/managed-runtime-session-contract'
import { defineMethod, type RpcContext } from '../core'

function sessions(context: RpcContext): NonNullable<RpcContext['managedRuntimeSessions']> {
  if (!context.managedRuntimeSessions) {
    throw new Error('managed_session_runtime_device_required')
  }
  return context.managedRuntimeSessions
}

export const MANAGED_RUNTIME_SESSION_METHODS = [
  defineMethod({
    name: 'pairing.managedRuntimeSession.open',
    permission: 'workspace',
    params: ManagedRuntimeSessionOpenSchema,
    handler: ({ subjectKey, name, grants }, context) =>
      sessions(context).open(subjectKey, name, grants)
  }),
  defineMethod({
    name: 'pairing.managedRuntimeSession.renew',
    permission: 'workspace',
    params: ManagedRuntimeSessionSelectorSchema,
    handler: ({ deviceId }, context) => sessions(context).renew(deviceId)
  }),
  defineMethod({
    name: 'pairing.managedRuntimeSession.revoke',
    permission: 'workspace',
    params: ManagedRuntimeSessionSelectorSchema,
    handler: ({ deviceId }, context) => ({ revoked: sessions(context).revoke(deviceId) })
  })
] as const
