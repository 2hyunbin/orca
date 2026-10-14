import { z } from 'zod'
import type { Project, ProjectHostSetup } from '../../../src/shared/project-types'
import type { Repo } from '../../../src/shared/repo-types'
import { salvagingArray } from '../../../src/shared/zod-salvage'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'

// The three catalogs the desktop sidebar groups Project sections by, read from one host.

const optionalHostId = z.string().nullable().optional()

// Every member grouping, labelling and ordering read; the rest of each record passes through.
const repoGroupingMembers = z.looseObject({
  id: z.string(),
  displayName: z.string(),
  path: z.string(),
  addedAt: z.number().optional(),
  connectionId: optionalHostId,
  executionHostId: optionalHostId
})
const projectGroupingMembers = z.looseObject({ id: z.string(), displayName: z.string() })
const setupGroupingMembers = z.looseObject({
  id: z.string(),
  projectId: z.string(),
  hostId: z.string(),
  repoId: z.string(),
  path: z.string(),
  setupMethod: z.string().optional(),
  kind: z.string().optional(),
  connectionId: optionalHostId,
  executionHostId: optionalHostId
})

// SAFETY: each row is the host's own record of that type; the members above are checked, and the
// shared normalizers the fetch runs next (adoption, projection) repair the ones they own.
const repoRowSchema = z.custom<Repo>((row) => repoGroupingMembers.safeParse(row).success)
const projectRowSchema = z.custom<Project>((row) => projectGroupingMembers.safeParse(row).success)
const setupRowSchema = z.custom<ProjectHostSetup>(
  (row) => setupGroupingMembers.safeParse(row).success
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
