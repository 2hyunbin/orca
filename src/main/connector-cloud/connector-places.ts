// A place is where a Slack start may run; its id rebuilds the launch target with no lookup, so twins on other hosts stay apart.
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { ConnectorProject } from '../../shared/connector-cloud-contract'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import { splitGitRemoteKey } from '../../shared/git-remote-identity'
import { isFolderRepo } from '../../shared/repo-kind'
import type { AgentLaunchParams } from '../../shared/rpc-contract/agent-launch-params'
import { parseWslUncPath } from '../../shared/wsl-paths'
import type { RuntimeStore } from '../runtime/runtime-store-contract'
import {
  runtimeVisibleProjectGroups,
  runtimeVisibleRepos
} from '../runtime/runtime-visible-catalog'

const Place = z.union([
  z.tuple([z.literal('git'), z.string().min(1), z.string().min(1)]),
  z.tuple([z.literal('folder'), z.string().min(1)])
])
type Place = z.infer<typeof Place>

export type ConnectorPlacesStore = Pick<
  RuntimeStore,
  'getRepos' | 'getProjectGroups' | 'getFolderWorkspaces' | 'getSshTargets' | 'getProjectHostSetups'
>

function encodePlace(place: Place): string {
  return Buffer.from(JSON.stringify(place)).toString('base64url')
}

function decodePlace(placeId: string): Place | null {
  try {
    const parsed = Place.safeParse(JSON.parse(Buffer.from(placeId, 'base64url').toString('utf8')))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** A pure function of the delivery, so a resent start hashes to the same receipt. */
export function placeLaunchTarget(
  placeId: string,
  deliveryId: string
): AgentLaunchParams['target'] | null {
  const place = decodePlace(placeId)
  if (!place) {
    return null
  }
  const name = `slack-${createHash('sha256').update(deliveryId).digest('hex').slice(0, 8)}`
  if (place[0] === 'folder') {
    return { kind: 'create-folder-workspace', create: { projectGroupId: place[1], name } }
  }
  const [, repoHostId, repoId] = place
  const hostId = parseExecutionHostId(repoHostId)?.id
  return hostId
    ? {
        kind: 'create-worktree',
        create: { repo: `id:${repoId}`, repoHostId: hostId, name, nameWasGenerated: true }
      }
    : null
}

/** Never paths: where a place runs, by host kind and label only. Null for a paired server's place, which it lists itself. */
function placeWhere(
  hostId: ExecutionHostId,
  path: string | null,
  store: ConnectorPlacesStore
): ConnectorProject['where'] | null {
  const host = parseExecutionHostId(hostId)
  if (host?.kind === 'ssh') {
    const label = store.getSshTargets?.().find((target) => target.id === host.targetId)?.label
    return { kind: 'ssh', ...(label ? { label } : {}) }
  }
  if (host?.kind !== 'local') {
    return null
  }
  const wsl = path ? parseWslUncPath(path) : null
  return wsl ? { kind: 'wsl', label: wsl.distro } : { kind: 'local' }
}

/** Git repos (each a fresh worktree) and folder projects (each a fresh folder workspace). */
export function connectorProjects(store: ConnectorPlacesStore): ConnectorProject[] {
  const projects: ConnectorProject[] = []
  for (const repo of runtimeVisibleRepos(store)) {
    const hostId = getRepoExecutionHostId(repo)
    const where = isFolderRepo(repo) ? null : placeWhere(hostId, repo.path, store)
    if (!where) {
      continue
    }
    const remote = splitGitRemoteKey(repo.gitRemoteIdentity?.canonicalKey, (host) => host)?.tail
    projects.push({
      placeId: encodePlace(['git', hostId, repo.id]),
      name: repo.displayName,
      ...(remote ? { remote } : {}),
      kind: 'git',
      where
    })
  }
  for (const group of runtimeVisibleProjectGroups(store)) {
    const where = group.parentPath
      ? placeWhere(getRepoExecutionHostId(group), group.parentPath, store)
      : null
    if (where) {
      projects.push({
        placeId: encodePlace(['folder', group.id]),
        name: group.name,
        kind: 'folder',
        where
      })
    }
  }
  return projects
}
