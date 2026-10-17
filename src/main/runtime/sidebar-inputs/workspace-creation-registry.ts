import { randomUUID } from 'node:crypto'
import type {
  WorkspaceCreation,
  WorkspaceCreationsSnapshot
} from '../../../shared/sidebar-list/workspace-creations'

/** Every creation this host is running, whoever asked: its own window, a phone, the CLI. */
export class WorkspaceCreationRegistry {
  private readonly creations = new Map<string, WorkspaceCreation>()
  private revision = 0

  /**
   * Lists the creation while `create` runs. `create` names the workspace once it is persisted;
   * the entry is dropped when `create` settles. A caller without an id gets one, so a CLI create
   * is listed too.
   */
  async track<T>(
    start: { creationId?: string; repoId: string },
    create: (named: (worktreeId: string) => void) => Promise<T>
  ): Promise<T> {
    const creationId = start.creationId ?? randomUUID()
    const entry: WorkspaceCreation = { repoId: start.repoId }
    this.creations.set(creationId, entry)
    this.revision += 1
    // Identity, not id: a concurrent retry under the same id owns the entry from then on.
    const owns = (): boolean => this.creations.get(creationId) === entry
    try {
      return await create((worktreeId) => {
        if (owns() && entry.worktreeId !== worktreeId) {
          entry.worktreeId = worktreeId
          this.revision += 1
        }
      })
    } finally {
      if (owns()) {
        this.creations.delete(creationId)
        this.revision += 1
      }
    }
  }

  snapshot(): WorkspaceCreationsSnapshot {
    const creations: WorkspaceCreationsSnapshot['creations'] = {}
    for (const [creationId, entry] of this.creations) {
      creations[creationId] = { ...entry }
    }
    return { revision: this.revision, creations }
  }
}
