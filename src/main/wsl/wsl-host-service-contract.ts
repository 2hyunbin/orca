import type { WslHostServerStop, WslHostStatus } from '../../shared/wsl-host-types'
import type { WslHostDistroCandidate } from './wsl-host-distro-list'
import type { WslOrcadConnection } from './wsl-orcad-connection'
import type { WslOrcadConnectIntent } from './wsl-orcad-connection-status'

/** `stopped` and `unreachable` rest on a confirmed running list; `unavailable` could not read it. */
export type WslHostReachability = 'available' | 'unreachable' | 'stopped' | 'unavailable'

/** The WSL side the service drives: C3 holder, C5 connections, C6 liveness (or an e2e fake). */
export type WslHostConnector = {
  listDistros(): Promise<WslHostDistroCandidate[]>
  /** Runs in the distro, so it boots a stopped one: only after the user chose to. */
  readOrcadPublicKey(distro: string): Promise<string | null>
  /** User-initiated; may boot the distro. An intent retries or forces a skipped update. */
  connect(distro: string, options?: WslOrcadConnectIntent): Promise<WslOrcadConnection>
  /** The user asked again: a standing pairing-repair failure or spent cap must not answer it. */
  forgetPairingFailures?(environmentId: string): void
  get(distro: string): WslOrcadConnection | null
  /** Checks the paired server without starting a stopped or unconfirmed distro. */
  isReachable(distro: string, environmentId: string): Promise<boolean>
  /** The same check, telling a confirmed-stopped distro from an unconfirmed one. */
  reachability(distro: string, environmentId: string): Promise<WslHostReachability>
  /** Liveness is deciding whether the distro stopped; its running list may be stale. */
  isSettling(distro: string): boolean
  disconnect(distro: string): Promise<void>
  /** Ends the host's terminals, orcad and its terminal daemon; never boots a stopped distro. */
  stopServer(distro: string, environmentId: string): Promise<WslHostServerStop>
  releaseHolder(distro: string): Promise<void>
  adoptHolders(): Promise<void>
  dispose(): Promise<void>
}

export type WslHostServiceDependencies = {
  userDataPath: () => string
  isEnabled: () => boolean
  /** Whether this build ships the orcad template a WSL host deploys from. */
  hasServerFiles: () => boolean
  publish: (status: WslHostStatus) => void
  /** The environment's pairing changed: transports that authenticate with the old one retire. */
  pairingChanged: (environmentId: string) => void
  /** A connection came up: verify the server now rather than on the status owner's backoff. */
  ready: (environmentId: string) => void
  removed: (environmentId: string) => Promise<void> | void
  call?: (
    environmentId: string,
    method: string,
    params: unknown,
    timeoutMs: number,
    beforeSend?: () => void
  ) => Promise<unknown>
}
