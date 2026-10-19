import { getAppEnvironment } from '../../../shared/app-environment'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { listEnvironments } from '../../../shared/runtime-environment-store'
import { deriveRelayHostId } from '../mobile-cloud-relay/relay-http-client'

/**
 * The push fingerprints a paired server signs its own pushes with: the gateway stamps
 * `deriveRelayHostId` of the host key, and the phone derives the same value from the key it paired with.
 */
export function resolveExecutionHostPushFingerprints(
  executionHost: string,
  userDataPath: string = getAppEnvironment().getPath('userData')
): string[] {
  const parsed = parseExecutionHostId(executionHost)
  if (parsed?.kind !== 'runtime') {
    return []
  }
  let environment: ReturnType<typeof listEnvironments>[number] | undefined
  try {
    environment = listEnvironments(userDataPath).find((entry) => entry.id === parsed.environmentId)
  } catch {
    // Unknown means forward: a duplicate beats a lost alert.
    return []
  }
  return [
    ...new Set(
      (environment?.endpoints ?? []).map((endpoint) =>
        deriveRelayHostId(Buffer.from(endpoint.publicKeyB64, 'base64'))
      )
    )
  ]
}
