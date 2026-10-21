import {
  getSavedWorktreeLineage,
  mergeWorkspaceLineageRecords
} from '../shared/resolved-worktree-lineage'
import { getRepoIdFromWorktreeId, splitWorktreeId } from '../shared/worktree/id'
import { getRepoExecutionHostId } from '../shared/execution-host'
import {
  composeWorktreeHostIdentity,
  getWorktreeHostIdentity
} from '../shared/worktree/host-qualified-identity'
import type { Worktree } from '../shared/worktree/types'
import { folderWorkspaceToWorktree } from '../shared/folder-workspace-worktree'
import { mergeWorktree } from './ipc/worktree-metadata-merge'
import type { RuntimeStore } from './runtime/runtime-store-contract'

export type CandidateStore = Partial<
  Pick<
    RuntimeStore,
    | 'getRepos'
    | 'getAllWorktreeMeta'
    | 'getWorktreeLineageMetadata'
    | 'getAllWorktreeLineage'
    | 'getAllWorkspaceLineage'
    | 'getFolderWorkspaces'
    | 'onStateWritten'
  >
>
function capture(store: CandidateStore) {
  const lineageById = mergeWorkspaceLineageRecords(
    { ...store.getAllWorktreeLineage?.() },
    { ...store.getAllWorkspaceLineage?.() }
  )
  const rawMetadata = Object.fromEntries(
    Object.entries(store.getAllWorktreeMeta?.() ?? {}).map(([id, meta]) => [id, { ...meta }])
  )
  const metadata = (
    store.getWorktreeLineageMetadata?.() ??
    Object.entries(rawMetadata).map(([id, meta]) => ({ id, meta }))
  ).map(({ id, meta }) => ({ id, meta: { ...meta } }))
  const repos = store.getRepos?.() ?? []
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
  const metadataByIdentity = new Map(
    metadata.map(({ id, meta }) => [composeWorktreeHostIdentity(meta.hostId, id), meta])
  )
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
  return {
    lineageById,
    rawMetadata,
    metadataByIdentity,
    repos,
    reposById,
    metadataForHost(hostId: string): typeof rawMetadata {
      return Object.fromEntries([
        ...Object.entries(rawMetadata).filter(([, meta]) => !meta.hostId || meta.hostId === hostId),
        ...metadata
          .filter(({ meta }) => meta.hostId === hostId)
          .map(({ id, meta }) => [id, meta] as const)
      ])
    },
    folders,
    rows: [
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
              hostId:
                meta.hostId ?? (owners.length === 1 ? getRepoExecutionHostId(owners[0]) : undefined)
            }
          }),
          ...folders
        ].map((row) => [getWorktreeHostIdentity(row), row])
      ).values()
    ],
    edgeOf: (
      row: Pick<
        Worktree,
        'id' | 'instanceId' | 'hostId' | 'runtimeOwnerEnvironmentId' | 'savedLineage' | 'lineage'
      >
    ) => getSavedWorktreeLineage(row, lineageById, rawMetadata),
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
const indexes = new WeakMap<CandidateStore, { value?: ReturnType<typeof capture> }>()
/** Store writes notify synchronously; only known unrelated domains can preserve this snapshot. */
export function getWorktreeLineageCandidates(store: CandidateStore) {
  if (!store.onStateWritten) {
    return capture(store)
  }
  let entry = indexes.get(store)
  if (!entry) {
    entry = {}
    indexes.set(store, entry)
    const owned = entry
    store.onStateWritten((domains) => {
      if (
        !domains ||
        domains.some((domain) => !['workspaceSessions', 'ui', 'agentSessions'].includes(domain))
      ) {
        owned.value = undefined
      }
    })
  }
  return (entry.value ??= capture(store))
}
