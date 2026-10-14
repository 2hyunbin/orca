import { z } from 'zod'
import type { Project, ProjectHostSetup } from '../../../src/shared/project-types'
import type { Repo } from '../../../src/shared/repo-types'
import { salvagingArray } from '../../../src/shared/zod-salvage'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'

// The three catalogs the desktop sidebar groups Project sections by, read from one host. Each is
// a host's own record type; the checks cover the members grouping reads, and the shared
// normalizers the client runs next cover the rest. A row missing one drops, not the whole list.

function hasStrings(row: unknown, keys: readonly string[]): boolean {
  return (
    typeof row === 'object' &&
    row !== null &&
    keys.every((key) => typeof Reflect.get(row, key) === 'string')
  )
}

const repoRowSchema = z.custom<Repo>((row) => hasStrings(row, ['id', 'displayName', 'path']))
const projectRowSchema = z.custom<Project>((row) => hasStrings(row, ['id', 'displayName']))
const setupRowSchema = z.custom<ProjectHostSetup>((row) =>
  hasStrings(row, ['id', 'projectId', 'hostId', 'repoId', 'path'])
)

/** The host's repos, as the desktop renderer reads them for its all-host catalog. */
export const projectCatalogRepoListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'repo.project-catalog-or-skip',
    method: 'repo.list',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'project-catalog-repos',
      z.looseObject({ repos: salvagingArray(repoRowSchema) }).transform(({ repos }) => repos)
    )
  })
)

/** Absent on a desktop or server that predates it; the caller then derives projects from repos. */
export const projectCatalogProjectListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'project.list-or-skip',
    method: 'project.list',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'project-catalog-projects',
      z
        .looseObject({ projects: salvagingArray(projectRowSchema) })
        .transform(({ projects }) => projects)
    )
  })
)

/** Absent on a desktop or server that predates it; the caller then derives setups from repos. */
export const projectCatalogSetupListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'projectHostSetup.list-or-skip',
    method: 'projectHostSetup.list',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'project-catalog-setups',
      z.looseObject({ setups: salvagingArray(setupRowSchema) }).transform(({ setups }) => setups)
    )
  })
)
