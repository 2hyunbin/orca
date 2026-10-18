import type { AppState } from '@/store'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import { isVirtualEditorFile } from '@/store/slices/editor/tabs/editor-tab-content-type'
import { findRepoForHost } from '@/store/slices/repo-host-identity'
import { isLocalWindowsDesktopClient } from '@/lib/desktop-window-chrome'
import { isWindowsAbsolutePathLike } from '../../../shared/cross-platform-path'
import { isLocalExecutionHost, parseExecutionHostId } from '../../../shared/execution-host'
import { isGitRepoKind } from '../../../shared/repo-kind'
import { resolveEditorExternalWatchTargetRows } from './editor-external-watch-target-rows'
import {
  addWatchConsumer,
  getOpenFileWatchConsumer,
  getSidebarWatchConsumer,
  type WatchConsumer
} from './editor-external-watch-consumers'
import {
  mergeRelativePaths,
  scopeEditorExternalWatchTargets,
  selectRecursiveWatchWorkspaceIds
} from './editor-external-watch-scope'

export { getOpenFileRuntimeOwner } from './editor-external-watch-consumers'

export type EditorExternalWatchTarget = {
  worktreeId: string
  worktreePath: string
  connectionId: string | undefined
  runtimeEnvironmentId: string | null
  allowLocalWindowsWslAliases?: true
  /** Set for a background local workspace: watch only these open files' directories, non-recursively. */
  narrowFiles?: string[]
}

export type EditorExternalWatchTargetState = Pick<
  AppState,
  | 'openFiles'
  | 'worktreesByRepo'
  | 'repos'
  | 'activeWorktreeId'
  | 'settings'
  | 'rightSidebarOpen'
  | 'rightSidebarTab'
  | 'rightSidebarExplorerView'
  | 'gitStatusHugeByWorktree'
  | 'sshConnectionStates'
  | 'folderWorkspaces'
  | 'projectGroups'
> &
  Partial<
    Pick<
      AppState,
      'activeWorkspaceExecutionHostId' | 'rightSidebarEffectiveTab' | 'lastVisitedAtByWorktreeId'
    >
  >

type WatchedTargetsSnapshot = {
  targets: EditorExternalWatchTarget[]
  targetsKey: string
}

let cachedOpenFiles: AppState['openFiles'] | null = null
let cachedWorktreesByRepo: AppState['worktreesByRepo'] | null = null
let cachedRepos: AppState['repos'] | null = null
let cachedActiveWorktreeId: string | null = null
let cachedActiveWorkspaceExecutionHostId: AppState['activeWorkspaceExecutionHostId'] = null
let cachedRuntimeEnvironmentId: string | undefined
let cachedRightSidebarOpen: boolean | null = null
let cachedRightSidebarTab: AppState['rightSidebarTab'] | null = null
let cachedRightSidebarEffectiveTab: AppState['rightSidebarEffectiveTab'] | undefined
let cachedRightSidebarExplorerView: AppState['rightSidebarExplorerView'] | null = null
let cachedGitStatusHugeByWorktree: AppState['gitStatusHugeByWorktree'] | null = null
let cachedSshConnectionStates: AppState['sshConnectionStates'] | null = null
let cachedFolderWorkspaces: AppState['folderWorkspaces'] | null = null
let cachedProjectGroups: AppState['projectGroups'] | null = null
let cachedLastVisitedAtByWorktreeId: AppState['lastVisitedAtByWorktreeId'] | undefined
let cachedWatchedTargetsSnapshot: WatchedTargetsSnapshot = { targets: [], targetsKey: '' }

export function getEditorExternalWatchTargetKey(target: EditorExternalWatchTarget): string {
  // Why: include connectionId so a local placeholder watch is replaced by the real SSH watch once an SSH worktree's provider metadata hydrates.
  return `${target.worktreeId}::${target.worktreePath}::${target.connectionId ?? 'local'}::${target.runtimeEnvironmentId ?? 'client'}::${target.allowLocalWindowsWslAliases === true ? 'wsl-aliases' : 'literal'}${target.narrowFiles ? `::narrow:${JSON.stringify(target.narrowFiles)}` : ''}`
}

export function getLocalWindowsWslAliasOption(
  target: Pick<EditorExternalWatchTarget, 'allowLocalWindowsWslAliases'>
): Pick<EditorExternalWatchTarget, 'allowLocalWindowsWslAliases'> {
  return isLocalWindowsDesktopClient() && target.allowLocalWindowsWslAliases === true
    ? { allowLocalWindowsWslAliases: true }
    : {}
}

function canWatchLocalWindowsWslAliases(args: {
  worktreePath: string
  runtimeEnvironmentId: string | null
  connectionId: string | null | undefined
  worktree: AppState['worktreesByRepo'][string][number] | undefined
  repo: AppState['repos'][number] | undefined
  folderWorkspace: AppState['folderWorkspaces'][number] | undefined
  projectGroup: AppState['projectGroups'][number] | undefined
}): boolean {
  if (
    args.runtimeEnvironmentId !== null ||
    args.connectionId !== null ||
    !isWindowsAbsolutePathLike(args.worktreePath)
  ) {
    return false
  }
  if (args.worktree) {
    return (
      !!args.repo &&
      !args.worktree.runtimeOwnerEnvironmentId?.trim() &&
      isLocalExecutionHost(args.worktree.hostId) &&
      isLocalExecutionHost(args.repo.executionHostId)
    )
  }
  return (
    !!args.folderWorkspace &&
    isLocalExecutionHost(args.folderWorkspace.executionHostId) &&
    isLocalExecutionHost(args.projectGroup?.executionHostId)
  )
}

export function selectEditorExternalWatchTargets(
  state: EditorExternalWatchTargetState
): WatchedTargetsSnapshot {
  const runtimeEnvironmentId = state.settings?.activeRuntimeEnvironmentId?.trim() || undefined
  const activeWorkspaceExecutionHostId = state.activeWorkspaceExecutionHostId ?? null
  if (
    cachedOpenFiles === state.openFiles &&
    cachedWorktreesByRepo === state.worktreesByRepo &&
    cachedRepos === state.repos &&
    cachedActiveWorktreeId === state.activeWorktreeId &&
    cachedActiveWorkspaceExecutionHostId === activeWorkspaceExecutionHostId &&
    cachedRuntimeEnvironmentId === runtimeEnvironmentId &&
    cachedRightSidebarOpen === state.rightSidebarOpen &&
    cachedRightSidebarTab === state.rightSidebarTab &&
    cachedRightSidebarEffectiveTab === state.rightSidebarEffectiveTab &&
    cachedRightSidebarExplorerView === state.rightSidebarExplorerView &&
    cachedGitStatusHugeByWorktree === state.gitStatusHugeByWorktree &&
    cachedSshConnectionStates === state.sshConnectionStates &&
    cachedFolderWorkspaces === state.folderWorkspaces &&
    cachedProjectGroups === state.projectGroups &&
    cachedLastVisitedAtByWorktreeId === state.lastVisitedAtByWorktreeId
  ) {
    return cachedWatchedTargetsSnapshot
  }

  const consumersByWorktreeId = new Map<string, Map<string, WatchConsumer>>()
  // Why: watcher ownership is scoped by worktree + execution host — the same workspace id can be open locally, over SSH and in a runtime, and reads/saves already route per host.
  for (const file of state.openFiles) {
    // Why: a virtual tab (CI details, chat visual) has no file in the workspace to watch.
    if (isVirtualEditorFile(file)) {
      continue
    }
    addWatchConsumer(consumersByWorktreeId, file.worktreeId, getOpenFileWatchConsumer(file))
  }
  const activeWorktreeId = state.activeWorktreeId
  const activeWorktree = activeWorktreeId
    ? findWorktreeById(state.worktreesByRepo, activeWorktreeId)
    : undefined
  const activeWorktreeHost = parseExecutionHostId(activeWorktree?.hostId)
  const activeRepo = activeWorktree
    ? activeWorktreeHost?.kind === 'local'
      ? (findRepoForHost(state.repos, activeWorktree.repoId, {
          hostId: activeWorktreeHost.id
        }) ?? undefined)
      : state.repos.find((repo) => repo.id === activeWorktree.repoId)
    : undefined
  const sourceControlCanConsumeWatch =
    !!activeWorktreeId &&
    !!activeRepo &&
    isGitRepoKind(activeRepo) &&
    !state.gitStatusHugeByWorktree[activeWorktreeId] &&
    (!activeRepo.connectionId ||
      state.sshConnectionStates.get(activeRepo.connectionId)?.status === 'connected')
  // Why: the stored tab can be hidden for this workspace (Source Control on a folder) while Explorer renders as the fallback.
  const shownRightSidebarTab = state.rightSidebarEffectiveTab ?? state.rightSidebarTab
  const activeWorktreeNeedsSidebarWatch =
    activeWorktreeId !== null &&
    state.rightSidebarOpen &&
    ((shownRightSidebarTab === 'explorer' && state.rightSidebarExplorerView === 'files') ||
      (shownRightSidebarTab === 'source-control' && sourceControlCanConsumeWatch))
  if (activeWorktreeNeedsSidebarWatch) {
    // Why: this app-level watcher owns Explorer/Source-Control subscriptions so downstream consumers don't fight over watch/unwatch IPC.
    addWatchConsumer(
      consumersByWorktreeId,
      activeWorktreeId,
      getSidebarWatchConsumer(state, activeWorktreeId)
    )
  }

  const targetsByKey = new Map<string, EditorExternalWatchTarget>()
  const relativePathsByKey = new Map<string, string[] | null>()
  for (const [id, consumers] of consumersByWorktreeId) {
    for (const { owner, hostId, relativePaths } of consumers.values()) {
      const rows = resolveEditorExternalWatchTargetRows(state, id, hostId)
      if (!rows || (rows.connectionId === undefined && rows.folderWorkspace)) {
        continue
      }
      const { worktree, repo, folderWorkspace, projectGroup, connectionId } = rows
      const target = {
        worktreeId: id,
        worktreePath: worktree?.path ?? folderWorkspace!.folderPath,
        connectionId: connectionId ?? undefined,
        runtimeEnvironmentId: owner,
        ...(canWatchLocalWindowsWslAliases({
          worktreePath: worktree?.path ?? folderWorkspace!.folderPath,
          runtimeEnvironmentId: owner,
          connectionId,
          worktree,
          repo,
          folderWorkspace,
          projectGroup
        })
          ? { allowLocalWindowsWslAliases: true as const }
          : {})
      }
      const key = getEditorExternalWatchTargetKey(target)
      targetsByKey.set(key, target)
      relativePathsByKey.set(
        key,
        relativePathsByKey.has(key)
          ? mergeRelativePaths(relativePathsByKey.get(key) ?? null, relativePaths)
          : relativePaths
      )
    }
  }
  const scopedTargetsByKey = scopeEditorExternalWatchTargets(
    targetsByKey,
    relativePathsByKey,
    selectRecursiveWatchWorkspaceIds(state.activeWorktreeId, state.lastVisitedAtByWorktreeId),
    getEditorExternalWatchTargetKey
  )

  // Why: consumers on one host (an unqualified legacy tab and its captured sibling) collapse to one watch.
  const sortedEntries = Array.from(scopedTargetsByKey).sort(([left], [right]) =>
    left.localeCompare(right)
  )
  const nextTargets = sortedEntries.map(([, target]) => target)
  const targetsKey = sortedEntries.map(([key]) => key).join('|')
  cachedOpenFiles = state.openFiles
  cachedWorktreesByRepo = state.worktreesByRepo
  cachedRepos = state.repos
  cachedActiveWorktreeId = state.activeWorktreeId
  cachedActiveWorkspaceExecutionHostId = activeWorkspaceExecutionHostId
  cachedRuntimeEnvironmentId = runtimeEnvironmentId
  cachedRightSidebarOpen = state.rightSidebarOpen
  cachedRightSidebarTab = state.rightSidebarTab
  cachedRightSidebarEffectiveTab = state.rightSidebarEffectiveTab
  cachedRightSidebarExplorerView = state.rightSidebarExplorerView
  cachedGitStatusHugeByWorktree = state.gitStatusHugeByWorktree
  cachedSshConnectionStates = state.sshConnectionStates
  cachedFolderWorkspaces = state.folderWorkspaces
  cachedProjectGroups = state.projectGroups
  cachedLastVisitedAtByWorktreeId = state.lastVisitedAtByWorktreeId

  if (targetsKey === cachedWatchedTargetsSnapshot.targetsKey) {
    return cachedWatchedTargetsSnapshot
  }

  cachedWatchedTargetsSnapshot = { targets: nextTargets, targetsKey }
  return cachedWatchedTargetsSnapshot
}
