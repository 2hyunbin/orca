import type {
  WorktreeLineage,
  WorkspaceLineage,
  ParentWorktreeRef
} from '../../shared/worktree/lineage-types'
import type { WorkspaceKey } from '../../shared/folder-workspace-types'
import {
  folderWorkspaceKey,
  parseWorkspaceKey,
  worktreeWorkspaceKey
} from '../../shared/workspace-scope'
import {
  indexWorktreesByInstance,
  isValidResolvedWorktreeLineageEdge
} from '../../shared/resolved-worktree-lineage'
import { getWorktreeHostIdentity } from '../../shared/worktree/host-qualified-identity'
import type { OrchestrationDb } from './orchestration/db'
import type { RuntimeStore } from './runtime-store-contract'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import { isWslMoveWorktreeBlocked } from '../persistence/moving-wsl-projects/wsl-move-background-backoff'
import {
  RuntimeLineageError,
  resolveRuntimeWorktreeCreateLineage,
  type ResolvedWorkspaceParent,
  type WorktreeLineageCandidate,
  type WorktreeLineageInput,
  type WorktreeLineageResolution
} from './runtime-worktree-lineage-resolution'

type RuntimeWorktreeLineageDependencies = {
  getStore(): RuntimeStore | null
  getCachedWorktrees(): readonly ResolvedWorktree[] | null
  getDb(): OrchestrationDb | null
  resolveWorktree(selector: string): Promise<ResolvedWorktree>
  listResolvedWorktrees(): Promise<ResolvedWorktree[]>
  showTerminal(handle: string): Promise<{ worktreeId: string }>
}

export class RuntimeWorktreeLineageController {
  constructor(private readonly deps: RuntimeWorktreeLineageDependencies) {}

  async resolveCreate(input?: WorktreeLineageInput): Promise<WorktreeLineageResolution> {
    if (input?.parentWorktreeRef && !input.noParent) {
      return {
        kind: 'lineage',
        parent: await this.resolveParentReference(input.parentWorktreeRef),
        origin: input.parentWorktreeRef.origin ?? 'cli',
        capture: input.parentWorktreeRef.capture ?? {
          source: 'explicit-cli-flag',
          confidence: 'explicit'
        }
      }
    }
    const resolution = await resolveRuntimeWorktreeCreateLineage(input, {
      resolveParent: (selector) => this.resolveParent(selector),
      resolveWorktreeParent: (selector) => this.resolveWorktreeParent(selector),
      resolveTaskCandidate: (taskId) => this.resolveTaskCandidate(taskId),
      resolveCaller: async (handle) => {
        const terminal = await this.deps.showTerminal(handle)
        const parent = await this.resolveParent(`id:${terminal.worktreeId}`)
        const db = this.deps.getDb()
        const dispatch = db?.getActiveDispatchForTerminal(handle)
        const run = db?.getActiveCoordinatorRun()
        return {
          parent,
          ...(dispatch ? { activeDispatch: { taskId: dispatch.task_id } } : {}),
          ...(run ? { activeRun: { id: run.id, coordinatorHandle: run.coordinator_handle } } : {})
        }
      }
    })
    return resolution
  }

  async resolveParentReference(ref: ParentWorktreeRef): Promise<ResolvedWorkspaceParent> {
    const row = indexWorktreesByInstance(await this.deps.listResolvedWorktrees()).get(
      ref.instanceId
    )
    if (row === null) {
      throw new RuntimeLineageError(
        'LINEAGE_PARENT_CONTEXT_CONFLICT',
        'Parent instance identity is ambiguous.'
      )
    }
    return row
      ? {
          type: 'worktree',
          workspaceKey: worktreeWorkspaceKey(row.id),
          worktree: row,
          instanceId: row.instanceId ?? null
        }
      : {
          type: 'external',
          workspaceKey: worktreeWorkspaceKey(ref.worktreeId),
          worktree: { id: ref.worktreeId },
          instanceId: ref.instanceId
        }
  }

  async resolveParent(selector: string): Promise<ResolvedWorkspaceParent> {
    const rawSelector = selector.startsWith('id:') ? selector.slice(3) : selector
    const parsed = parseWorkspaceKey(rawSelector)
    if (parsed?.type === 'folder') {
      const folderWorkspace = this.deps
        .getStore()
        ?.getFolderWorkspaces?.()
        .find((workspace) => workspace.id === parsed.folderWorkspaceId)
      if (!folderWorkspace) {
        throw new Error('selector_not_found')
      }
      return {
        type: 'folder',
        workspaceKey: folderWorkspaceKey(folderWorkspace.id),
        folderWorkspace,
        instanceId: null
      }
    }
    return this.resolveWorktreeParent(
      parsed?.type === 'worktree' ? `id:${parsed.worktreeId}` : selector
    )
  }

  async resolveWorktreeParent(selector: string): Promise<ResolvedWorkspaceParent> {
    const worktree = await this.deps.resolveWorktree(selector)
    return {
      type: 'worktree',
      workspaceKey: worktreeWorkspaceKey(worktree.id),
      worktree,
      instanceId: worktree.instanceId ?? null
    }
  }

  validateParent(child: ResolvedWorktree, parent: ResolvedWorktree): void {
    const rows = new Map(
      (this.deps.getCachedWorktrees() ?? []).map((row) => [getWorktreeHostIdentity(row), row])
    )
    rows.set(getWorktreeHostIdentity(child), child)
    rows.set(getWorktreeHostIdentity(parent), parent)
    const byInstance = indexWorktreesByInstance(rows.values())
    if (parent.instanceId && byInstance.get(parent.instanceId) === null) {
      throw new RuntimeLineageError(
        'LINEAGE_PARENT_CONTEXT_CONFLICT',
        'Parent instance identity is ambiguous.'
      )
    }
    let cursor: ResolvedWorktree | null | undefined = parent
    const visited = new Set<string>([getWorktreeHostIdentity(child)])
    while (cursor) {
      const key = getWorktreeHostIdentity(cursor)
      if (visited.has(key)) {
        throw new RuntimeLineageError(
          'LINEAGE_PARENT_CYCLE',
          'Parent selector would create a lineage cycle.'
        )
      }
      visited.add(key)
      const lineage = this.deps.getStore()?.getWorktreeLineage?.(cursor.id)
      const next = lineage ? byInstance.get(lineage.parentWorktreeInstanceId) : undefined
      cursor =
        lineage && next && isValidResolvedWorktreeLineageEdge(cursor, next, lineage)
          ? next
          : undefined
    }
  }

  async resolveTaskCandidate(taskId: string): Promise<WorktreeLineageCandidate | null> {
    const db = this.deps.getDb()
    const dispatch = db?.getDispatchContext(taskId)
    const handle = dispatch?.assignee_handle ?? db?.getTask(taskId)?.created_by_terminal_handle
    if (!handle) {
      return null
    }
    try {
      const terminal = await this.deps.showTerminal(handle)
      return {
        source: 'orchestration-context',
        parent: await this.resolveWorktreeParent(`id:${terminal.worktreeId}`),
        taskId
      }
    } catch {
      return null
    }
  }

  async hydrate(): Promise<void> {
    const store = this.deps.getStore()
    if (!store?.getWorktreeLineage || !store.setWorktreeLineage) {
      return
    }
    for (const worktree of await this.deps.listResolvedWorktrees()) {
      if (
        store.getWorktreeLineage(worktree.id) ||
        !worktree.instanceId ||
        isWslMoveWorktreeBlocked(worktree.id, worktree.hostId, worktree.path)
      ) {
        continue
      }
      const taskId = worktree.comment?.match(/\btask_[A-Za-z0-9]+\b/)?.[0]
      if (!taskId) {
        continue
      }
      const candidate = await this.resolveTaskCandidate(taskId)
      if (
        !candidate?.parent.instanceId ||
        candidate.parent.type !== 'worktree' ||
        getWorktreeHostIdentity(candidate.parent.worktree) === getWorktreeHostIdentity(worktree)
      ) {
        continue
      }
      try {
        this.validateParent(worktree, candidate.parent.worktree)
      } catch {
        continue
      }
      store.setWorktreeLineage(worktree.id, {
        worktreeId: worktree.id,
        worktreeInstanceId: worktree.instanceId,
        parentWorktreeId: candidate.parent.worktree.id,
        parentWorktreeInstanceId: candidate.parent.instanceId,
        origin: 'orchestration',
        capture: { source: 'orchestration-context', confidence: 'inferred' },
        taskId,
        createdAt: Date.now()
      })
    }
  }

  async listWorktreeLineage(): Promise<Record<string, WorktreeLineage>> {
    await this.hydrate()
    return this.deps.getStore()?.getAllWorktreeLineage?.() ?? {}
  }

  async listWorkspaceLineage(): Promise<Record<WorkspaceKey, WorkspaceLineage>> {
    await this.hydrate()
    return this.deps.getStore()?.getAllWorkspaceLineage?.() ?? {}
  }
}
