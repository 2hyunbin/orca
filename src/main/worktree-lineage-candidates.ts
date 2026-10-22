import {
  getSavedWorktreeLineage,
  lineageStoreKeyForRow,
  projectResolvedWorktreeLineage,
  mergeWorkspaceLineageRecords
} from '../shared/resolved-worktree-lineage'
import { getRepoIdFromWorktreeId, splitWorktreeId } from '../shared/worktree/id'
import { getRepoExecutionHostId } from '../shared/execution-host'
import { getWorktreeHostIdentity } from '../shared/worktree/host-qualified-identity'
import type { Worktree } from '../shared/worktree/types'
import { folderWorkspaceToWorktree } from '../shared/folder-workspace-worktree'
import { mergeWorktree } from './ipc/worktree-metadata-merge'
import type { RuntimeStore } from './runtime/runtime-store-contract'

export type LineageStore = Partial<
  Pick<
    RuntimeStore,
    | 'getRepos'
    | 'getAllWorktreeMeta'
    | 'getWorktreeLineageMetadata'
    | 'getAllWorktreeLineage'
    | 'getAllWorkspaceLineage'
    | 'getFolderWorkspaces'
  >
>
export function readWorktreeLineageCorpus(store: LineageStore) {
  const lineageById = mergeWorkspaceLineageRecords(
    Object.fromEntries(
      Object.entries(store.getAllWorktreeLineage?.() ?? {}).map(([id, edge]) => [id, { ...edge }])
    ),
    Object.fromEntries(
      Object.entries(store.getAllWorkspaceLineage?.() ?? {}).map(([id, edge]) => [id, { ...edge }])
    )
  )
  const rawMetadata = Object.fromEntries(
    Object.entries(store.getAllWorktreeMeta?.() ?? {}).map(([id, meta]) => [id, { ...meta }])
  )
  const metadata = (
    store.getWorktreeLineageMetadata?.() ??
    Object.entries(rawMetadata).map(([id, meta]) => ({ id, meta }))
  ).map(({ id, meta }) => ({ id, meta: { ...meta } }))
  const repos = store.getRepos?.() ?? []
  const repoHosts = new Map(repos.map((repo) => [repo, getRepoExecutionHostId(repo)]))
  const reposById = new Map<string, typeof repos>()
  for (const repo of repos) {
    reposById.set(repo.id, [...(reposById.get(repo.id) ?? []), repo])
  }
  const hostsById = new Map<string, Set<string>>()
  for (const { id, meta } of metadata) {
    if (meta.hostId) {
      hostsById.set(id, new Set([...(hostsById.get(id) ?? []), meta.hostId]))
    }
  }
  const folders = store.getFolderWorkspaces?.().map(folderWorkspaceToWorktree) ?? []
  const byInstance = new Map<string, Set<string>>()
  for (const row of [
    ...metadata.map(({ id, meta }) => ({ id, instanceId: meta.instanceId })),
    ...folders
  ]) {
    if (!row.instanceId) {
      continue
    }
    const ids = byInstance.get(row.instanceId) ?? new Set<string>()
    ids.add(row.id)
    byInstance.set(row.instanceId, ids)
  }
  const adjacent = new Map<string, Set<string>>()
  const connect = (a: string, b: string) => {
    const ids = adjacent.get(a) ?? new Set<string>()
    ids.add(b)
    adjacent.set(a, ids)
  }
  for (const edge of Object.values(lineageById)) {
    const candidates = new Set([
      edge.parentWorktreeId,
      ...(byInstance.get(edge.parentWorktreeInstanceId) ?? [])
    ])
    for (const parent of candidates) {
      connect(edge.worktreeId, parent)
      connect(parent, edge.worktreeId)
    }
  }
  const currentRow = <T extends Worktree>(row: T): T => {
    if (lineageStoreKeyForRow(row)) {
      return row
    }
    const owners = reposById.get(row.repoId) ?? []
    return {
      ...row,
      hostId: row.hostId ?? (owners.length === 1 ? repoHosts.get(owners[0]) : undefined),
      savedLineage: undefined,
      lineage: null
    }
  }
  let rows: Worktree[] | undefined
  return {
    lineageById,
    rawMetadata,
    repos,
    reposById,
    folders,
    get rows() {
      return (rows ??= [
        ...new Map(
          [
            ...metadata.map(({ id, meta }) => {
              const owners = reposById.get(getRepoIdFromWorktreeId(id)) ?? []
              const merged = mergeWorktree(
                getRepoIdFromWorktreeId(id),
                {
                  path: splitWorktreeId(id)?.worktreePath ?? '',
                  head: '',
                  branch: '',
                  isBare: false,
                  isMainWorktree: false
                },
                meta
              )
              return {
                ...merged,
                id,
                hostId: meta.hostId ?? (owners.length === 1 ? repoHosts.get(owners[0]) : undefined)
              }
            }),
            ...folders
          ].map((row) => [getWorktreeHostIdentity(row), row])
        ).values()
      ])
    },
    currentRow,
    hasCurrent(row: Worktree) {
      const key = getWorktreeHostIdentity(currentRow(row))
      return this.rows.some(
        (candidate) =>
          getWorktreeHostIdentity(candidate) === key && candidate.instanceId === row.instanceId
      )
    },
    edgeOf: (row: Worktree) => getSavedWorktreeLineage(currentRow(row), lineageById, rawMetadata),
    project<T extends Worktree>(supplied: readonly T[]) {
      return projectResolvedWorktreeLineage(
        supplied.map(currentRow),
        lineageById,
        this.rows.map(currentRow),
        rawMetadata
      )
    },
    relatedRepos(seeds: readonly string[]) {
      const ids = this.relatedIds(seeds)
      const byRepo = new Map<string, Set<string>>()
      for (const id of ids) {
        const repoId = getRepoIdFromWorktreeId(id)
        const hosts = byRepo.get(repoId) ?? new Set<string>()
        for (const host of hostsById.get(id) ?? []) {
          hosts.add(host)
        }
        byRepo.set(repoId, hosts)
      }
      return [...byRepo].flatMap(([id, hosts]) =>
        (reposById.get(id) ?? []).filter(
          (repo) => hosts.size === 0 || hosts.has(getRepoExecutionHostId(repo))
        )
      )
    },
    relatedIds(seeds: readonly string[]) {
      const ids = new Set(seeds.filter((id) => adjacent.has(id)))
      for (const id of ids) {
        for (const peer of adjacent.get(id) ?? []) {
          ids.add(peer)
        }
      }
      return ids
    }
  }
}

/** Current own-store facts supersede cached publication carriers at an action boundary. */
export function projectCurrentStoreWorktreeLineage<T extends Worktree>(
  store: LineageStore,
  rows: readonly T[]
) {
  const facts = readWorktreeLineageCorpus(store)
  return facts.project(rows)
}
