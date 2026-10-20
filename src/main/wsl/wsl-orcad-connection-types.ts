/** The public shape of the desktop's connection to one WSL distro's orcad. */
import type { PairingOffer } from '../../shared/pairing'
import type { ServeReadiness } from '../server/serve-readiness'
import type { OrcadHostTransport } from '../ssh/orcad-host-transport'
import type { OrcadTunnelIdentity } from '../managed-server/lifecycle/orcad-managed-tunnel-identity'
import type { StartedPortForward } from '../ssh/port-forwarding/ssh-port-forward-provider'
import type { WslDistroHolder } from './wsl-distro-holder'
import type { WslOrcadConnectionStatus } from './wsl-orcad-connection-status'
import type {
  WslOrcadDeferredUpdate,
  WslOrcadDeployOptions,
  WslOrcadLaunch
} from './wsl-orcad-deploy'
import type { WslOrcadHostTarget } from './wsl-orcad-host-target'
import type { WslOrcadStdioBridgeOptions } from './wsl-orcad-stdio-bridge'

export type WslOrcadConnection = {
  distro: string
  environmentId: string
  /** The loopback port on this machine the pairing offer points at. */
  localPort: number
  /** orcad's port inside the distro. */
  remotePort: number
  fullVersion: string
  /** orcad's pid inside the distro, from its pid file; null when unreadable. */
  pid: number | null
  /** orcad's pairing code, with its endpoint rewritten to `ws://127.0.0.1:<localPort>`. */
  pairingOffer: string
  /** An app update the incumbent `fullVersion` is waiting to take (live terminals). */
  deferredUpdate: WslOrcadDeferredUpdate | null
  close(): Promise<void>
}

export type WslOrcadConnectOptions = {
  environmentId?: string
  label?: string
  /** Rebinds a port a persisted pairing offer already names; 0 or absent picks a free one. */
  localPort?: number
  force?: boolean
  signal?: AbortSignal
  /** What `onChange` reports while this connect runs and once it is ready (liveness recovery). */
  status?: WslOrcadConnectStatus
}

export type WslOrcadConnectStatus = {
  pending: WslOrcadConnectionStatus
  ready: WslOrcadConnectionStatus
}

export type WslOrcadConnectionDependencies = {
  holder?: WslDistroHolder
  getPairingOffer?: (environmentId: string) => PairingOffer | null
  deployAndLaunch?: (distro: string, options: WslOrcadDeployOptions) => Promise<WslOrcadLaunch>
  createTransport?: (target: WslOrcadHostTarget) => OrcadHostTransport
  listen?: (
    transport: OrcadHostTransport,
    options: WslOrcadStdioBridgeOptions
  ) => Promise<StartedPortForward>
  verifyIdentity?: (pairingOffer: string, readiness: ServeReadiness) => Promise<OrcadTunnelIdentity>
  /** A connection (re)opened, its offer changed, or its status moved; null once it closed. */
  onChange?: (
    distro: string,
    connection: WslOrcadConnection | null,
    status: WslOrcadConnectionStatus
  ) => void
}
