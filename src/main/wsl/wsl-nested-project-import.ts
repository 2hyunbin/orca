import { posix } from 'node:path'
import { z } from 'zod'
import { normalizeRuntimePathForComparison as selectionKey } from '../../shared/cross-platform-path'
import { LOCAL_EXECUTION_HOST_ID, toRuntimeExecutionHostId } from '../../shared/execution-host'
import type {
  NestedRepoScanResult,
  ProjectGroupImportMode,
  ProjectGroupImportResult
} from '../../shared/project-group-types'
import type { Repo } from '../../shared/repo-types'
import { parseWslUncPath } from '../../shared/wsl-paths'
import {
  admitRepositoryCheckout,
  type RepositoryCheckoutAdmission
} from '../repository-checkout-admission'
import { scanNestedRepos } from '../project-groups/nested-repo-discovery'
import { resolveNestedRepoSelection } from '../project-groups/nested-repo-import'
import { createNestedRepoImportTargetResolver } from '../project-groups/nested-repo-import-target'
import {
  callWslProjectHost,
  listWslOwnerRepos,
  registerOnWslOwner,
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
  options: { fromPairedClient?: boolean; scan?: NestedRepoScanResult } = {}
): Promise<ProjectGroupImportResult | null> {
  const parent = parseWslUncPath(args.parentPath)
  if (args.connectionId || !parent || !wslProjectRoutingEnabled(store)) {
    return null
  }
  const scan =
    options.scan ??
    (await scanNestedRepos({
      path: args.parentPath,
      options: { timeoutMs: 15_000 }
    }))
  const selection = resolveNestedRepoSelection({ scan, projectPaths: args.projectPaths })
  const targetResolver = createNestedRepoImportTargetResolver()
  const results = new Map<string, ProjectGroupImportResult['projects'][number]>()
  const selected: {
    path: string
    selectedLinuxPath: string
    linuxPath: string
    admission: RepositoryCheckoutAdmission
  }[] = []
  for (const path of selection.selectedPaths) {
    try {
      const target = await targetResolver.resolveLocal(path)
      const admission = await admitRepositoryCheckout(store, target, 'git', LOCAL_EXECUTION_HOST_ID)
      const parsed = parseWslUncPath(admission.registrationPath)
      const original = parseWslUncPath(path)
      if (!parsed || !original || parsed.distro.toLowerCase() !== parent.distro.toLowerCase()) {
        throw new Error('Selected projects must belong to the selected WSL distro.')
      }
      selected.push({
        path,
        selectedLinuxPath: original.linuxPath,
        linuxPath: parsed.linuxPath,
        admission
      })
    } catch (error) {
      results.set(selectionKey(path), {
        path,
        status: 'failed',
        error: error instanceof Error ? error.message : 'Repository could not be inspected'
      })
    }
  }
  // An uninspectable selection has no proven Windows claim; never send it to local fallback.
  const inspectionFailed = results.size > 0
  const hasNew = () => inspectionFailed || selected.some((entry) => !entry.admission.findSaved())
  if (!hasNew()) {
    return null
  }
  const refuseMixedGroup = () => {
    if (
      args.mode === 'group' &&
      hasNew() &&
      selected.some((entry) => entry.admission.findSaved())
    ) {
      throw new Error(
        'Some of these projects are already saved on Windows. Import them separately instead of as a group.'
      )
    }
  }
  refuseMixedGroup()
  const owner = await resolveNewWslProjectHost(store, args.parentPath, options)
  if (!owner) {
    return null
  }
  refuseMixedGroup()
  if (!hasNew()) {
    return null
  }
  const executionHostId = toRuntimeExecutionHostId(owner.environmentId)
  const knownIds = new Set((await listWslOwnerRepos(owner.environmentId)).map((repo) => repo.id))
  const registered = new Map<string, ProjectGroupImportResult['projects'][number]>()
  for (const { path, linuxPath, admission } of selected) {
    const saved = admission.findSaved()
    if (saved) {
      results.set(selectionKey(path), {
        path,
        projectId: saved.id,
        status: 'already-known',
        executionHostId: LOCAL_EXECUTION_HOST_ID
      })
      continue
    }
    const key = linuxPathKey(linuxPath)
    const previous = registered.get(key)
    if (previous) {
      results.set(selectionKey(path), {
        ...previous,
        path,
        status: previous.status === 'imported' ? 'already-known' : previous.status
      })
      continue
    }
    let result: ProjectGroupImportResult['projects'][number]
    try {
      const repo = await registerOnWslOwner(owner.environmentId, {
        kind: 'add',
        path: linuxPath,
        repoKind: 'git'
      })
      result = {
        path,
        projectId: repo.id,
        status: knownIds.has(repo.id) ? 'already-known' : 'imported',
        executionHostId
      }
      knownIds.add(repo.id)
    } catch (error) {
      // Registration may have committed before transport/setup failed; keep the useful row visible.
      const repos = await listWslOwnerRepos(owner.environmentId).catch(() => [])
      const repo = repos.find((row) => linuxPathKey(row.path) === key)
      result = {
        path,
        projectId: repo?.id,
        status: 'failed',
        executionHostId,
        error: error instanceof Error ? error.message : 'Repository could not be prepared'
      }
    }
    registered.set(key, result)
    results.set(selectionKey(path), result)
  }
  let group: ProjectGroupImportResult['group']
  const successful = selected.filter(
    ({ path }) => results.get(selectionKey(path))?.status !== 'failed'
  )
  if (args.mode === 'group' && successful.length > 0) {
    try {
      const grouped = ImportReply.parse(
        await callWslProjectHost(owner.environmentId, 'projectGroup.importNested', {
          parentPath: parent.linuxPath,
          mode: 'group',
          groupName: args.groupName?.trim() || posix.basename(parent.linuxPath) || parent.distro,
          projectPaths: successful.map(({ selectedLinuxPath }) => selectedLinuxPath)
        })
      )
      group = grouped.group ? { ...grouped.group, executionHostId } : undefined
      for (const { path, selectedLinuxPath } of successful) {
        const expected = results.get(selectionKey(path))
        if (!expected) {
          continue
        }
        const groupedItem = grouped.projects.find(
          (item) => linuxPathKey(item.path) === linuxPathKey(selectedLinuxPath)
        )
        if (
          !group ||
          groupedItem?.status === 'failed' ||
          groupedItem?.projectId !== expected.projectId
        ) {
          results.set(selectionKey(path), {
            ...expected,
            projectId: groupedItem?.projectId ?? expected.projectId,
            status: 'failed',
            error: 'The project was added, but its group or preparation could not be completed.'
          })
        }
      }
    } catch {
      for (const { path } of successful) {
        const result = results.get(selectionKey(path))
        if (result) {
          results.set(selectionKey(path), {
            ...result,
            status: 'failed',
            error: 'The project was added, but its group could not be completed.'
          })
        }
      }
    }
  }
  const seen = new Set<string>()
  const projects = args.projectPaths.flatMap((path) => {
    if (seen.has(selectionKey(path))) {
      return []
    }
    seen.add(selectionKey(path))
    const result = results.get(selectionKey(path))
    if (result) {
      return [{ ...result, path }]
    }
    if (selection.rejectedPaths.includes(path)) {
      return [
        {
          path,
          status: 'failed' as const,
          error: 'Repository was not found in the nested repo scan result'
        }
      ]
    }
    return []
  })
  return {
    executionHostId,
    ...(group ? { group } : {}),
    projects,
    importedCount: projects.filter((row) => row.status === 'imported').length,
    alreadyKnownCount: projects.filter((row) => row.status === 'already-known').length,
    failedCount: projects.filter((row) => row.status === 'failed').length
  }
}
