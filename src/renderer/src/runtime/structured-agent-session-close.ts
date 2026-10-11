import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import {
  callRuntimeRpc,
  runtimeEnvironmentSupportsCapability,
  type RuntimeClientTarget
} from './runtime-rpc-client'
import { captureRuntimeEnvironmentRequestRevision } from './runtime-environment-revision'

export async function closeStructuredAgentSession(
  target: RuntimeClientTarget,
  sessionId: string,
  options: { expectedEnvironmentPairingRevision?: number } = {}
): Promise<'closed' | 'unsupported'> {
  const expectedEnvironmentPairingRevision =
    target.kind === 'environment'
      ? captureRuntimeEnvironmentRequestRevision(
          target.environmentId,
          options.expectedEnvironmentPairingRevision
        )
      : undefined
  if (
    target.kind === 'environment' &&
    !(await runtimeEnvironmentSupportsCapability(
      target.environmentId,
      STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
    ))
  ) {
    return 'unsupported'
  }
  await callRuntimeRpc(
    target,
    'agentSession.close',
    { sessionId },
    {
      expectedEnvironmentPairingRevision
    }
  )
  return 'closed'
}
