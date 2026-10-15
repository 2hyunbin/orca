import { z } from 'zod'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID, toRuntimeExecutionHostId } from '../../shared/execution-host'
import type { ProjectGroupImportMode, ProjectGroupImportResult } from '../../shared/project-group-types'
import type { Repo } from '../../shared/repo-types'
import { foldWslUncPathCaseInsensitiveParts, parseWslUncPath, toWindowsWslUncPath } from '../../shared/wsl-paths'
import { callWslProjectHost, resolveNewWslProjectHost } from './wsl-project-registration'

const ImportReply = z.object({
  group: z.object({
    id: z.string(), name: z.string(), parentPath: z.string().nullable(),
    parentGroupId: z.string().nullable(), createdFrom: z.enum(['manual', 'folder-scan', 'migration']),
    tabOrder: z.number(), isCollapsed: z.boolean(), color: z.string().nullable(),
    createdAt: z.number(), updatedAt: z.number()
  }).passthrough().optional(),
  projects: z.array(z.object({
    path: z.string(), projectId: z.string().optional(),
    status: z.enum(['imported', 'already-known', 'failed']), error: z.string().optional()
  })),
  importedCount: z.number(), alreadyKnownCount: z.number(), failedCount: z.number()
})

export async function importNestedProjectsOnWslHost(
  store: { getRepos(): Repo[] },
  args: { parentPath: string; projectPaths: string[]; groupName?: string; mode: ProjectGroupImportMode; connectionId?: string | null }
): Promise<ProjectGroupImportResult | null> {
  if (args.connectionId) {
    return null
  }
  // Each selected project is checked separately; a saved parent folder is not a new import.
  const owner = await resolveNewWslProjectHost(store, args.parentPath, null)
  const parent = parseWslUncPath(args.parentPath)
  if (!owner || 'repo' in owner || !parent) {
    return null
  }
  const existing: ProjectGroupImportResult['projects'] = []
  const projectPaths: string[] = []
  for (const path of args.projectPaths) {
    const parsed = parseWslUncPath(path)
    if (!parsed || parsed.distro.toLowerCase() !== parent.distro.toLowerCase()) {
      throw new Error('Selected projects must belong to the selected WSL distro.')
    }
    const key = foldWslUncPathCaseInsensitiveParts(path)
    const known = store.getRepos().find((repo) =>
      getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID &&
      foldWslUncPathCaseInsensitiveParts(repo.path) === key
    )
    if (known) {
      existing.push({ path, projectId: known.id, status: 'already-known' })
    } else {
      projectPaths.push(parsed.linuxPath)
    }
  }
  const response = await callWslProjectHost(
    owner.environmentId, 'projectGroup.importNested',
    { ...args, parentPath: owner.linuxPath, projectPaths }
  )
  const result = ImportReply.parse(response)
  const executionHostId = toRuntimeExecutionHostId(owner.environmentId)
  return {
    ...result, executionHostId,
    ...(result.group ? { group: { ...result.group, executionHostId } } : {}),
    projects: [...existing, ...result.projects.map((project) => ({
      ...project, path: toWindowsWslUncPath(project.path, parent.distro)
    }))],
    alreadyKnownCount: result.alreadyKnownCount + existing.length
  }
}
