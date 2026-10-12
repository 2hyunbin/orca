import type { Repo } from '../../../../shared/repo-types'
import { isFloatingWorkspaceSelector } from '../../../../shared/floating-workspace-worktree'
import { resolveWorktreeLaunchHost } from '../../worktree-launch-host-repo'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ResolvedWorktree } from '../../runtime-worktree-path-identity'
import type { Worktree } from '../../../../shared/worktree/types'
import type { TerminalWorkspaceLaunchScope } from '../../runtime-legacy-worker-terminal-recovery-types'
import { resolveTerminalStartupCwd } from '../../../../shared/terminal-startup-cwd'
import {
  type ResolvedTerminalWorkspaceLaunchTarget,
  AGENT_HOOK_RUNTIME_ENV_KEYS
} from '../../orca-runtime-core'
import { ensureJcodeRuntimeDir } from '../../../../shared/jcode-runtime-dir'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { resolveCreatedWorktreeTerminalTarget } from '../../runtime-created-worktree-terminal-target'
import type { RuntimeStore } from '../../runtime-store-contract'
import type { RuntimeWorkspaceSelectors } from '../../workspaces/workspace-selectors'

export type RuntimeTerminalWorkspaceLaunchHost = {
  resolveTerminalWorkspaceLaunchTarget(): RuntimeTerminalWorkspaceLaunch['resolveTerminalWorkspaceLaunchTarget']
  materializeTerminalPushTarget(worktree: ResolvedWorktree, repo: Repo | null): void
  resolveFloatingWorkspacePath(): () => Promise<string>
  resolveFolderWorkspaceLaunchScope(): (
    selector: string
  ) => Promise<(TerminalWorkspaceLaunchScope & { folderWorkspace: FolderWorkspace }) | null>
  folderWorkspaceToResolvedWorktree(): (folderWorkspace: FolderWorkspace) => ResolvedWorktree
  getStore(): Pick<
    RuntimeStore,
    'getRepos' | 'getRepo' | 'getWorktreeMeta' | 'getWorktreeMetaForHost' | 'getAllWorktreeLineage'
  > | null
  resolveWorktreeSelector(): (
    ...args: Parameters<RuntimeWorkspaceSelectors['resolveWorktreeSelector']>
  ) => ReturnType<RuntimeWorkspaceSelectors['resolveWorktreeSelector']>
  buildAgentHookPtyEnv?(): Record<string, string> | undefined
}

export class RuntimeTerminalWorkspaceLaunch {
  constructor(private readonly host: RuntimeTerminalWorkspaceLaunchHost) {}
  private get store() {
    return this.host.getStore()
  }
  resolveWorkspaceTerminalStartupCwd(
    workspace: Pick<TerminalWorkspaceLaunchScope, 'path'>,
    requestedCwd?: string | null
  ): string | undefined {
    return resolveTerminalStartupCwd(workspace.path, requestedCwd)
  }

  async resolveTerminalWorkspaceLaunchScope(
    selector: string,
    createdWorktree?: Worktree
  ): Promise<TerminalWorkspaceLaunchScope> {
    return (await this.host.resolveTerminalWorkspaceLaunchTarget()(selector, createdWorktree)).scope
  }

  async resolveTerminalWorkspaceLaunchTarget(
    selector: string,
    createdWorktree?: Worktree
  ): Promise<ResolvedTerminalWorkspaceLaunchTarget> {
    if (isFloatingWorkspaceSelector(selector)) {
      // Why no managed worktree: the floating sentinel has no repo or worktree record behind it.
      return {
        scope: {
          id: FLOATING_TERMINAL_WORKTREE_ID,
          path: await this.host.resolveFloatingWorkspacePath()(),
          connectionId: null,
          repo: null,
          folderWorkspace: null
        },
        managedWorktree: null
      }
    }

    const folderScope = await this.host.resolveFolderWorkspaceLaunchScope()(selector)
    if (folderScope) {
      return {
        scope: folderScope,
        managedWorktree: this.host.folderWorkspaceToResolvedWorktree()(folderScope.folderWorkspace)
      }
    }

    const workspaceSelector = selector.startsWith('id:') ? selector.slice(3) : selector
    const parsed = parseWorkspaceKey(workspaceSelector)
    const worktreeSelector = parsed?.type === 'worktree' ? `id:${parsed.worktreeId}` : selector
    const worktree =
      resolveCreatedWorktreeTerminalTarget(this.store, selector, createdWorktree) ??
      (await this.host.resolveWorktreeSelector()(worktreeSelector))
    // Why: `getRepo(id)` is host-blind and the same repo id can exist on local, SSH and runtime
    // hosts. Reading `connectionId` off an arbitrary row reports "local" for a remote worktree and
    // spawns its PTY on the client with the remote cwd (#11163). Loss of a usable answer is
    // `unresolved`, never `local`.
    const resolution = resolveWorktreeLaunchHost(this.store?.getRepos() ?? [], worktree)
    if (resolution.kind === 'ambiguous') {
      throw new Error('worktree_execution_host_unresolved')
    }
    // Metadata only (display name, hook settings); the routing decision is `resolution.connectionId`.
    const repo = resolution.repo ?? this.store?.getRepo(worktree.repoId) ?? null
    this.host.materializeTerminalPushTarget(worktree, repo)
    return {
      scope: {
        id: worktree.id,
        path: worktree.path,
        connectionId: resolution.connectionId,
        repo,
        folderWorkspace: null
      },
      managedWorktree: worktree
    }
  }

  async buildTerminalWorkspaceEnv(
    scope: TerminalWorkspaceLaunchScope,
    baseEnv: Record<string, string>,
    paneKey: string,
    tabId: string,
    agentTeamsEnv?: Record<string, string>
  ): Promise<Record<string, string>> {
    const cleanBaseEnv = { ...baseEnv }
    for (const key of AGENT_HOOK_RUNTIME_ENV_KEYS) {
      delete cleanBaseEnv[key]
    }
    const jcodeRuntimeDirEnv =
      scope.connectionId === null ? await ensureJcodeRuntimeDir(paneKey) : undefined
    const env = {
      ...cleanBaseEnv,
      ...agentTeamsEnv,
      ...this.host.buildAgentHookPtyEnv?.(),
      // Why: the runtime dir is a local unix-socket path; remote (SSH)
      // terminals must keep jcode on its own guest-side default daemon.
      ...jcodeRuntimeDirEnv,
      ORCA_PANE_KEY: paneKey,
      ORCA_TAB_ID: tabId,
      ORCA_WORKTREE_ID: scope.id
    }
    if (!scope.folderWorkspace) {
      return env
    }
    return {
      ...env,
      ORCA_WORKSPACE_ID: scope.id,
      ORCA_PROJECT_GROUP_ID: scope.folderWorkspace.projectGroupId,
      ORCA_WORKSPACE_ROOT: scope.folderWorkspace.folderPath
    }
  }
}
