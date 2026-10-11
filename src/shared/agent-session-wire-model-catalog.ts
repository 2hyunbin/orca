import type { AgentSessionUnavailable } from './agent-session-availability'

// The host's model catalog for an agent, as a picker and a session's options read it.

export type AgentSessionOptionChoice = {
  value: string
  label: string
  description?: string
}

export type AgentSessionModelOption = {
  id: string
  label: string
  description?: string
  isDefault: boolean
  defaultEffort?: string
  efforts: AgentSessionOptionChoice[]
  /** Provider catalog fact. Absent means the host could not determine support. */
  supportsFastMode?: boolean
  /** The provider's own id this listed alias runs; a selection saved as either names this row. */
  resolvedModel?: string
  /** Service tiers the provider lists for this model besides its standard one, each valued by the
   *  provider's own tier id. Absent means unknown; a client that reads it offers one speed choice
   *  (`default` for standard) in place of the Fast toggle. */
  serviceTiers?: AgentSessionOptionChoice[]
}

export type AgentSessionFastModeState = 'off' | 'cooldown' | 'on'

export type AgentSessionFastModeSupport = {
  supported: boolean
  /** Provider-authored or host-normalized reason code; presentation may ignore unknown values. */
  reason?: string
}

/**
 * The host's model catalog for an agent, answered from its own store and
 * never through a session's queue. `unknown` means this host has no listing
 * for the key yet — the client keeps its static seed. Additive read-only
 * surface: an older host simply lacks the method.
 */
export type AgentSessionModelCatalogResult = {
  /** The host is running the listing this answer is waiting on (its first for the account, or
   *  the probe re-checking `unavailable`); a `waitForListing` read answers when it lands. Absent
   *  from a host that predates it; such a host sends it only with `unknown`. */
  listingInProgress?: true
  /** Why no chat can start under the account, as the host's probe last found it. Absent is
   *  unknown, which shows nothing; an older host never sends it. */
  unavailable?: AgentSessionUnavailable
  /** Sent only while the list is current (listed within the last minute, nothing running or
   *  failed) for an agent whose host replaces a gone model: a selection this list does not name is
   *  gone, and the host starts that chat on this model, the account's listed default. Absent (any
   *  doubt, or an older host) keeps a selection. */
  unlistedModelReplacement?: string
} & (
  | { origin: 'unknown' }
  | {
      /** What produced the listing; any age is served, `fetchedAt` carries it. */
      origin: 'live-session' | 'probe'
      models: AgentSessionModelOption[]
      fastModeSupport?: AgentSessionFastModeSupport
      fetchedAt: number
      /** The listed default is the model a new chat here launches with: the agent's listing names
       *  its configured model and no workspace config can replace it. Absent from an older host. */
      listingNamesConfiguredModel?: boolean
      /** The named default holds in every workspace: the agent reads no project config for its
       *  model, so an answer naming no workspace serves any new chat. Absent from an older host. */
      defaultHoldsInEveryWorkspace?: true
    }
)
