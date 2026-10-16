import type { RuntimeCapability } from '../../../shared/protocol-version'
import type { RemoteRuntimePassthroughSocket } from '../../../shared/remote-runtime-passthrough-socket'
import type { MobileRelayWorkDemand } from './mobile-relay-work-demand'
import { RelayedPhoneReplies } from './relayed-phone-frames'

/** The phone connection a relayed request arrived on. */
export type RelayedPhone = {
  connectionId: string
  deviceId: string
  deviceToken: string
  clientCapabilities: () => readonly RuntimeCapability[]
  reply: (frame: string) => void
  sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => boolean | void
}

export type OpenedRelayLink = { socket: RemoteRuntimePassthroughSocket; hostToken: string }

export class RelayLink {
  readonly replies: RelayedPhoneReplies
  readonly opened: Promise<OpenedRelayLink>
  demand: MobileRelayWorkDemand | null = null
  // Opening stays unbound until current registration and demand agree.
  preparing = true

  constructor(
    readonly environmentId: string,
    readonly phone: RelayedPhone,
    allocateStreamId: () => number,
    open: (link: RelayLink) => Promise<OpenedRelayLink>
  ) {
    this.replies = new RelayedPhoneReplies(allocateStreamId)
    this.opened = open(this)
  }
}
