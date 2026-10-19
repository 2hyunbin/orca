import { posix } from 'node:path'
import { z } from 'zod'
import { LOCAL_EXECUTION_HOST_ID, toRuntimeExecutionHostId } from '../../shared/execution-host'
import type {
  ProjectGroupImportMode,
  ProjectGroupImportResult
} from '../../shared/project-group-types'
import type { Repo } from '../../shared/repo-types'
import { foldWslUncPathCaseInsensitiveParts, parseWslUncPath } from '../../shared/wsl-paths'
import {
  callWslProjectHost,
  findSavedWindowsProjectAt,
  resolveNewWslProjectHost,
  wslProjectRoutingEnabled
} from './wsl-project-registration'

const ImportReply = z.object({
  group: z
    .object({
      id: z.string(),
      name: z.string(),
      parentPath: z.string().nullable(),
      parentGroupId: z.string().nullable(),
      createdFrom: z.enum(['manual', 'folder-scan', 'migration']),
      tabOrder: z.number(),
      isCollapsed: z.boolean(),
      color: z.string().nullable(),
      createdAt: z.number(),
      updatedAt: z.number()
    })
    .passthrough()
    .optional(),
  projects: z.array(
    z.object({
      path: z.string(),
      projectId: z.string().optional(),
      status: z.enum(['imported', 'already-known', 'failed']),
      error: z.string().optional()
    })
  ),
  importedCount: z.number(),
  alreadyKnownCount: z.number(),
  failedCount: z.number()
})

function linuxPathKey(path: string): string {
  return posix.normalize(path).replace(/\/+$/, '')
}

export async function importNestedProjectsOnWslHost(
  store: { getRepos(): Repo[] },
  args: {
    parentPath: string
    projectPaths: string[]
    groupName?: string
    mode: ProjectGroupImportMode
    connectionId?: string | null
  },
  options: { fromPairedClient?: boolean } = {}
): Promise<ProjectGroupImportResult | null> {
  const parent = parseWslUncPath(args.parentPath)
  if (args.connectionId || !parent || !wslProjectRoutingEnabled(store)) {
    return null
  }
  const selected = args.projectPaths.map((path) => {
    const parsed = parseWslUncPath(path)
    if (!parsed || parsed.distro.toLowerCase() !== parent.distro.toLowerCase()) {
      throw new Error('Selected projects must belong to the selected WSL distro.')
    }
    const key = foldWslUncPathCaseInsensitiveParts(path.replace(/[\\/]+$/, ''))
    const saved = key ? findSavedWindowsProjectAt(store.getRepos(), key) : undefined
    return { path, linuxPath: parsed.linuxPath, saved }
  })
  const newPaths = selected.filter((entry) => !entry.saved).map((entry) => entry.linuxPath)
  // Projects already saved on Windows keep the existing local import, group included.
  if (newPaths.length === 0) {
    return null
  }
  // Temporary until saved Windows projects can move to their distro: a group has one owner.
  if (args.mode === 'group' && newPaths.length < selected.length) {
    throw new Error(
      'Some of these projects are already saved on Windows. Import them separately instead of as a group.'
    )
  }
  const owner = await resolveNewWslProjectHost(store, args.parentPath, {
    ...options,
    targetKey: null
  })
  if (!owner || 'repo' in owner) {
    return null
  }
  const response = await callWslProjectHost(owner.environmentId, 'projectGroup.importNested', {
    ...args,
    parentPath: parent.linuxPath,
    projectPaths: newPaths
  })
  const result = ImportReply.parse(response)
  const executionHostId = toRuntimeExecutionHostId(owner.environmentId)
  const hosted = new Map(result.projects.map((project) => [linuxPathKey(project.path), project]))
  return {
    ...result,
    executionHostId,
    ...(result.group ? { group: { ...result.group, executionHostId } } : {}),
    // Why selection order: the first success is what the flow opens, and each row keeps its owner.
    projects: selected.map(({ path, linuxPath, saved }) =>
      saved
        ? {
            path,
            projectId: saved.id,
            status: 'already-known' as const,
            executionHostId: LOCAL_EXECUTION_HOST_ID
          }
        : {
            ...(hosted.get(linuxPathKey(linuxPath)) ?? { status: 'failed' as const }),
            path,
            executionHostId
          }
    ),
    alreadyKnownCount: result.alreadyKnownCount + selected.length - newPaths.length
  }
}
