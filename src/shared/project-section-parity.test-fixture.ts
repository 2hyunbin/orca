// One set of host answers both the desktop sidebar's and the phone's Project grouping tests run
// on: Jinwoo's shape, several checkouts of stablyai/orca locally and the same project on two
// servers. Each side must render exactly PROJECT_SECTION_PARITY_HEADERS from it.
import { foldHostProjectCatalogs, type AllHostProjectCatalog } from './all-host-project-catalog'
import { adoptEndpointProjectCatalog, adoptEndpointRepo } from './endpoint-catalog-adoption'
import type { ExecutionHostId } from './execution-host'
import {
  projectHostSetupProjectionFromRepos,
  type ProjectHostSetupProjection
} from './project-host-setup-projection'
import type { Repo } from './repo-types'
import type { RuntimeClientTarget } from './runtime-client-target'

const orcaRemote = {
  canonicalKey: 'github.com/stablyai/orca',
  remoteName: 'origin',
  remoteUrl: 'git@github.com:stablyai/orca.git'
}

function hostRepo(id: string, path: string, displayName = 'orca'): Repo {
  return {
    id,
    path,
    displayName,
    badgeColor: '#737373',
    addedAt: 1,
    ...(displayName === 'orca' ? { gitRemoteIdentity: orcaRemote } : {})
  }
}

export type ParityHostAnswer = {
  target: RuntimeClientTarget
  hostId: ExecutionHostId
  repos: Repo[]
  /** False for a host that predates project.list, so both sides derive from repos. */
  answersProjectLists: boolean
}

export const PROJECT_SECTION_PARITY_HOSTS: readonly ParityHostAnswer[] = [
  {
    target: { kind: 'local' },
    hostId: 'local',
    repos: [
      hostRepo('local-stably', '/Users/jinwoo/stably/orca'),
      hostRepo('local-workspace', '/Users/jinwoo/orca/workspaces/orca/orca'),
      hostRepo('local-assets', '/Users/jinwoo/design-assets', 'design-assets')
    ],
    answersProjectLists: true
  },
  {
    target: { kind: 'environment', environmentId: 'windows2' },
    hostId: 'runtime:windows2',
    repos: [hostRepo('win-orca', 'C:/Users/jinwo/orca/orca')],
    answersProjectLists: true
  },
  {
    target: { kind: 'environment', environmentId: 'm4air' },
    hostId: 'runtime:m4air',
    repos: [
      hostRepo('m4-orca', '/Users/m4air/orca/orca'),
      hostRepo('m4-orca-two', '/Users/m4air/orca-two/orca')
    ],
    answersProjectLists: false
  }
]

/** What a host answers for project.list and projectHostSetup.list: its own projection. */
export function parityHostProjectLists(host: ParityHostAnswer): ProjectHostSetupProjection {
  return projectHostSetupProjectionFromRepos(host.repos)
}

/** Workspace rows, newest activity first, so first-row order and Recent order agree. */
export const PROJECT_SECTION_PARITY_ROWS: readonly {
  id: string
  repoId: string
  lastActivityAt: number
}[] = [
  { id: 'wt-stably', repoId: 'local-stably', lastActivityAt: 60 },
  { id: 'wt-workspace', repoId: 'local-workspace', lastActivityAt: 50 },
  { id: 'wt-win', repoId: 'win-orca', lastActivityAt: 40 },
  { id: 'wt-m4', repoId: 'm4-orca', lastActivityAt: 30 },
  { id: 'wt-m4-two', repoId: 'm4-orca-two', lastActivityAt: 20 }
]

export const PROJECT_SECTION_PARITY_HEADERS: readonly { key: string; label: string }[] = [
  { key: 'project:github:stablyai/orca::setup:local-stably', label: 'jinwoo/stably/orca' },
  { key: 'project:github:stablyai/orca::setup:local-workspace', label: 'workspaces/orca/orca' },
  { key: 'project:github:stablyai/orca', label: 'jinwo/orca/orca' },
  { key: 'project:github:stablyai/orca::setup:m4-orca', label: 'm4air/orca/orca' },
  { key: 'project:github:stablyai/orca::setup:m4-orca-two', label: 'm4air/orca-two/orca' },
  { key: 'project:repo:local-assets', label: 'design-assets' }
]

/** The phone's path: each host's answers adopted as the phone fetches them, then folded. */
export function parityPhoneCatalog(): AllHostProjectCatalog {
  return foldHostProjectCatalogs(
    PROJECT_SECTION_PARITY_HOSTS.map((host) => {
      const repos = host.repos.map((repo) => adoptEndpointRepo(host.target, repo))
      const lists = parityHostProjectLists(host)
      return {
        hostId: host.hostId,
        repos,
        projection: host.answersProjectLists
          ? adoptEndpointProjectCatalog(host.target, lists.projects, lists.setups)
          : projectHostSetupProjectionFromRepos(repos)
      }
    })
  )
}
