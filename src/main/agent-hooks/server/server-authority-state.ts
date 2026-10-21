import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import type { AgentHookAuthorityEvidence } from './server-types'
import { RevisionedMap } from './revisioned-map'

/** Launch credentials are admitted independently of the latest status row. */
export abstract class AgentHookServerAuthorityState {
  protected hydratedAuthorityCommitments: readonly AgentHookAuthorityEvidence[] = Object.freeze([])
  // Why: revisioned so a persisted-authority change can bypass the write throttle (spool replay and
  // restored-terminal attestation read these after a crash).
  protected hydratedLaunchTokenHashByPaneKey = new RevisionedMap<string, string>()
  protected persistedAuthorityCommitmentsByPaneKey = new RevisionedMap<
    string,
    AgentHookAuthorityEvidence
  >()
  protected revokedHydratedAuthorityCommitments = new WeakSet<AgentHookAuthorityEvidence>()
  protected currentAuthorityObservations = new Map<string, AgentHookAuthorityEvidence>()
  protected pendingLaunchAuthority = new Map<
    string,
    {
      evidence: AgentHookAuthorityEvidence
      row: AgentHookEventPayload
      session?: { id: string; key: string }
    }
  >()
  protected launchAuthorityVerifier:
    | ((candidate: AgentHookAuthorityEvidence, terminalHandle?: string) => boolean)
    | null = null
  protected unsubscribeLaunchAuthority: (() => void) | null = null
}
