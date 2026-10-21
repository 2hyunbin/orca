import { getWorktreeLineageCandidates } from '../worktree-lineage-candidates'
import type { Worktree } from '../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../shared/worktree/host-qualified-identity'
import type { WorktreeLineage, WorkspaceLineage } from '../../shared/worktree/lineage-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { WorkspaceKey } from '../../shared/folder-workspace-types'
import {
  folderWorkspaceKey,
  parseWorkspaceKey,
  worktreeWorkspaceKey
} from '../../shared/workspace-scope'
import {
  isSameSavedWorktreeParent,
  resolveWorktreeLineageParents,
  sharesResolvedWorktreeLineageBoundary
} from '../../shared/resolved-worktree-lineage'
import type { OrchestrationDb } from './orchestration/db'
import type { RuntimeStore } from './runtime-store-contract'
import { worktreeRowTarget } from '../persistence/host-qualified-worktree-meta'
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
  getDb(): OrchestrationDb | null
  resolveWorktree(selector: string): Promise<ResolvedWorktree>
  listResolvedWorktrees(): Promise<ResolvedWorktree[]>
  showTerminal(handle: string): Promise<{ worktreeId: string }>
}

export class RuntimeWorktreeLineageController {
  constructor(private readonly deps: RuntimeWorktreeLineageDependencies) {}

  async resolveCreate(
    input?: WorktreeLineageInput,
    _childHostId?: ExecutionHostId
  ): Promise<WorktreeLineageResolution> {
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
        instanceId: folderWorkspaceKey(folderWorkspace.id)
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
    const store = this.deps.getStore()
    const snapshot = store ? getWorktreeLineageCandidates(store) : undefined
    const edgeOf = (row: Worktree) => snapshot?.edgeOf(row)
    const existing = edgeOf(child)
    if (
      isSameSavedWorktreeParent(existing, child, {
        worktreeId: parent.id,
        instanceId: parent.instanceId,
        external: !sharesResolvedWorktreeLineageBoundary(child, parent)
      })
    ) {
      return
    }
    if (getWorktreeHostIdentity(child) === getWorktreeHostIdentity(parent)) {
      throw new RuntimeLineageError('LINEAGE_PARENT_CYCLE', 'A worktree cannot parent itself.')
    }
    if (!sharesResolvedWorktreeLineageBoundary(child, parent)) {
      throw new RuntimeLineageError(
        'LINEAGE_PARENT_CONTEXT_CONFLICT',
        "Can't move an existing workspace under a parent whose chain reaches another Orca install. Create the new workspace from that parent instead, or clear its parent first."
      )
    }
    const rows = new Map((snapshot?.rows ?? []).map((row) => [getWorktreeHostIdentity(row), row]))
    rows.set(getWorktreeHostIdentity(child), child)
    rows.set(getWorktreeHostIdentity(parent), parent)
    const parents = resolveWorktreeLineageParents([...rows.values()], (row) =>
      row === child ? null : edgeOf(row)
    )
    let cursor: Worktree | undefined = parent
    const visited = new Set<Worktree>()
    while (cursor && !visited.has(cursor)) {
      if (cursor === child) {
        throw new RuntimeLineageError(
          'LINEAGE_PARENT_CYCLE',
          'Parent selector would create a lineage cycle.'
        )
      }
      visited.add(cursor)
      const edge = edgeOf(cursor)
      if (
        edge?.parentStore === 'external' &&
        (!edge.worktreeInstanceId || edge.worktreeInstanceId === cursor.instanceId)
      ) {
        throw new RuntimeLineageError(
          'LINEAGE_PARENT_CONTEXT_CONFLICT',
          "Can't move an existing workspace under a parent whose chain reaches another Orca install. Create the new workspace from that parent instead, or clear its parent first."
        )
      }
      cursor = parents.get(cursor)
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
        candidate.parent.worktree.id === worktree.id
      ) {
        continue
      }
      try {
        this.validateParent(worktree, candidate.parent.worktree)
      } catch {
        continue
      }
      const target = worktreeRowTarget(store, worktree)
      if (!target) {
        continue
      }
      store.setWorktreeLineage(target, {
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
