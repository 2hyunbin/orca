import { randomUUID } from 'node:crypto'
import type {
  WorkspaceCreation,
  WorkspaceCreationsSnapshot
} from '../../../shared/sidebar-list/workspace-creations'

type OpenCreation = { creationId: string; entry: WorkspaceCreation }

/**
 * Every creation this host is running, whoever asked: its own window, a phone, the CLI. A create
 * is opened under an owner (its request) once its project is known, and closed by that owner.
 */
export class WorkspaceCreationRegistry {
  private readonly creations = new Map<string, WorkspaceCreation>()
  private readonly openByOwner = new WeakMap<object, OpenCreation>()
  private revision = 0

  /** A caller without an id gets one, so a CLI create is listed too. */
  open(owner: object, start: { creationId?: string; repoId: string }): void {
    const creationId = start.creationId ?? randomUUID()
    const entry: WorkspaceCreation = { repoId: start.repoId }
    this.creations.set(creationId, entry)
    this.openByOwner.set(owner, { creationId, entry })
    this.revision += 1
  }

  /** Names the workspace once it is persisted, before the host announces it, then calls `next`. */
  naming(owner: object, next?: (worktreeId: string) => void): (worktreeId: string) => void {
    return (worktreeId) => {
      const open = this.ownedBy(owner)
      if (open && open.entry.worktreeId !== worktreeId) {
        open.entry.worktreeId = worktreeId
        this.revision += 1
      }
      next?.(worktreeId)
    }
  }

  /** Safe for an owner that never opened, e.g. a create refused before its project resolved. */
  close(owner: object): void {
    const open = this.ownedBy(owner)
    this.openByOwner.delete(owner)
    if (open) {
      this.creations.delete(open.creationId)
      this.revision += 1
    }
  }

  async track<T>(
    start: { creationId?: string; repoId: string },
    create: (named: (worktreeId: string) => void) => Promise<T>
  ): Promise<T> {
    const owner = {}
    this.open(owner, start)
    try {
      return await create(this.naming(owner))
    } finally {
      this.close(owner)
    }
  }

  snapshot(): WorkspaceCreationsSnapshot {
    const creations: WorkspaceCreationsSnapshot['creations'] = {}
    for (const [creationId, entry] of this.creations) {
      creations[creationId] = { ...entry }
    }
    return { revision: this.revision, creations }
  }

  // Identity, not id: a concurrent retry under the same id owns the entry from then on.
  private ownedBy(owner: object): OpenCreation | undefined {
    const open = this.openByOwner.get(owner)
    return open && this.creations.get(open.creationId) === open.entry ? open : undefined
  }
}
