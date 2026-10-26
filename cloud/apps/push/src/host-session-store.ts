import type { CloudDatabase } from '@orca-cloud/cloud-database'
import { HostSessionStore } from '@orca-cloud/host-handshake'
import { PUSH_LIMITS } from '@orca-cloud/push-contract'

export class PushHostSessionStore extends HostSessionStore {
  constructor(database: CloudDatabase, now?: () => number) {
    super(
      database,
      { table: 'push_sessions', lockScope: 'orca-push-session', ttlMs: PUSH_LIMITS.sessionTtlMs },
      now
    )
  }
}
