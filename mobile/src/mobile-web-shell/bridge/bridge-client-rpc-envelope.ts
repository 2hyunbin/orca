import {
  RpcEnvelopeFieldsSchema,
  type RpcEnvelopeFields
} from '../../transport/rpc-envelope-fields'
import { BridgeRpcEnvelopeRefusedError } from './bridge-client-errors'
import { BRIDGE_RPC_ENVELOPE_GRANT } from './bridge-frame-fields'

/**
 * The `envelope` a page frame carries for a caller's extra wire fields, or the refusal to send it.
 *
 * Absent and empty both mean no field, so a caller passing neither posts today's exact frame. The
 * check is the shell reader's own schema: a frame that reader drops is answered by nothing, and the
 * caller would wait for the life of the page.
 */
export function readBridgeRpcEnvelope(
  fields: RpcEnvelopeFields | undefined,
  nativeGrants: readonly string[] | undefined
): RpcEnvelopeFields | undefined | BridgeRpcEnvelopeRefusedError {
  if (fields === undefined || Object.keys(fields).length === 0) {
    return undefined
  }
  if (nativeGrants?.includes(BRIDGE_RPC_ENVELOPE_GRANT) !== true) {
    return new BridgeRpcEnvelopeRefusedError('not-granted')
  }
  const parsed = RpcEnvelopeFieldsSchema.safeParse(fields)
  return parsed.success ? parsed.data : new BridgeRpcEnvelopeRefusedError('invalid')
}

/** For `subscribe`, whose only refusal channel is a throw. */
export function requireBridgeRpcEnvelope(
  fields: RpcEnvelopeFields | undefined,
  nativeGrants: readonly string[] | undefined
): RpcEnvelopeFields | undefined {
  const envelope = readBridgeRpcEnvelope(fields, nativeGrants)
  if (envelope instanceof Error) {
    throw envelope
  }
  return envelope
}
