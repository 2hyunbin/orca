import { posix } from 'node:path'
import { normalizeRuntimePathForComparison as selectionKey } from '../../shared/cross-platform-path'
import { LOCAL_EXECUTION_HOST_ID, toRuntimeExecutionHostId } from '../../shared/execution-host'
import type {
  NestedRepoScanResult,
  ProjectGroupImportMode,
  ProjectGroupImportResult
} from '../../shared/project-group-types'
import type { Repo } from '../../shared/repo-types'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { normalizeWindowsWslPath } from '../../shared/windows-path-access'
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
  wslProjectRoutingEnabled,
  WslNestedImportReply
} from './wsl-project-registration'


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
  const requestKey = (path: string) => selectionKey(normalizeWindowsWslPath(path))
  const scan =
    options.scan ??
    (await scanNestedRepos({
      path: args.parentPath,
      options: { timeoutMs: 15_000 }
    }))
  const selection = resolveNestedRepoSelection({
    scan: {
      ...scan,
      selectedPath: normalizeWindowsWslPath(scan.selectedPath),
      repos: scan.repos.map((repo) => ({ ...repo, path: normalizeWindowsWslPath(repo.path) }))
    },
    projectPaths: args.projectPaths.map(normalizeWindowsWslPath)
  })
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
      const admission = await admitRepositoryCheckout(
        store,
        target,
        'git',
        LOCAL_EXECUTION_HOST_ID,
        true
      )
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
      results.set(requestKey(path), {
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
      results.set(requestKey(path), {
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
      results.set(requestKey(path), {
        ...previous,
        path,
        status: previous.status === 'imported' ? 'already-known' : previous.status
      })
      continue
    }
    let result: ProjectGroupImportResult['projects'][number]
    try {
      if (!wslProjectRoutingEnabled(store)) {
        throw new Error('Repository could not be prepared')
      }
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
    results.set(requestKey(path), result)
  }
  let group: ProjectGroupImportResult['group']
  const mixedOwners = [...results.values()].some(
    (result) => result.executionHostId !== undefined && result.executionHostId !== executionHostId
  )
  const successful = selected.filter(({ path }) => {
    const result = results.get(requestKey(path))
    return (
      result?.status !== 'failed' &&
      Boolean(result?.projectId?.trim()) &&
      result?.executionHostId === executionHostId
    )
  })
  if (args.mode === 'group' && mixedOwners) {
    for (const [key, result] of results) {
      if (result.status !== 'failed') {
        results.set(key, {
          ...result,
          status: 'failed',
          error: 'Some of these projects are already saved on Windows. Import them separately instead of as a group.'
        })
      }
    }
  }
  if (args.mode === 'group' && !mixedOwners && successful.length > 0) {
    try {
      if (!wslProjectRoutingEnabled(store)) {
        throw new Error('The project was added, but its group could not be completed.')
      }
      const grouped = WslNestedImportReply.parse(
        await callWslProjectHost(owner.environmentId, 'projectGroup.importNested', {
          parentPath: parent.linuxPath,
          mode: 'group',
          groupName: args.groupName?.trim() || posix.basename(parent.linuxPath) || parent.distro,
          projectPaths: successful.map(({ selectedLinuxPath }) => selectedLinuxPath)
        })
      )
      group = grouped.group ? { ...grouped.group, executionHostId } : undefined
      for (const { path, selectedLinuxPath } of successful) {
        const expected = results.get(requestKey(path))
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
          results.set(requestKey(path), {
            ...expected,
            projectId: groupedItem?.projectId ?? expected.projectId,
            status: 'failed',
            error: 'The project was added, but its group or preparation could not be completed.'
          })
        }
      }
    } catch {
      for (const { path } of successful) {
        const result = results.get(requestKey(path))
        if (result) {
          results.set(requestKey(path), {
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
    if (seen.has(requestKey(path))) {
      return []
    }
    seen.add(requestKey(path))
    const result = results.get(requestKey(path))
    if (result) {
      const unconfirmed =
        result.status !== 'failed' &&
        (!result.projectId?.trim() || result.executionHostId === undefined)
      return [
        {
          ...result,
          path,
          ...(unconfirmed
            ? { status: 'failed' as const, error: 'Repository could not be prepared' }
            : {})
        }
      ]
    }
    if (selection.rejectedPaths.some((rejected) => requestKey(rejected) === requestKey(path))) {
      return [
        {
          path,
          status: 'failed' as const,
          error: 'Repository was not found in the nested repo scan result'
        }
      ]
    }
    return [{ path, status: 'failed' as const, error: 'Repository could not be prepared' }]
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
