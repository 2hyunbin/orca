import type { JournalHostDatabase } from './journal-host-database'
import { LegacyRestReplay } from './journal-legacy-rest-worker-replay'
import {
  legacyRestPermitted,
  type LegacyRestExecutor,
  type LegacyRestRequest
} from './journal-legacy-rest-worker-protocol'

/** Test observer placement, never a production fallback or a replacement reader. */
export class InProcessLegacyRestWorker implements LegacyRestExecutor {
  private readonly replay: LegacyRestReplay
  private id = 0
  constructor(
    database: JournalHostDatabase,
    private readonly control: Int32Array
  ) {
    this.replay = new LegacyRestReplay(database.db, database.stateDirectory)
  }
  async grant(request: Omit<LegacyRestRequest, 'id'>, canWork: () => boolean) {
    return this.replay.grant(
      { ...request, id: ++this.id },
      () => legacyRestPermitted(this.control, request.generation) && canWork()
    )
  }
  async retire(): Promise<void> {
    this.replay.close()
  }
  async close(): Promise<void> {
    this.replay.close()
  }
}
