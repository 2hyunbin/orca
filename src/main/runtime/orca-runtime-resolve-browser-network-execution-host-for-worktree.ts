// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { triggerTerminalSpawnPushTargetMaterialization } from './runtime-terminal-spawn-push-target-materialization'
import { TerminalWorkspaceIdValidation } from './terminal/launch/terminal-workspace-id-validation'
import type { ExecutionHostId } from '../../shared/execution-host'
import { floatingWorkspaceToWorktree } from '../../shared/floating-workspace-worktree'
import { resolveFloatingTerminalCwd } from '../ipc/floating-workspace-directory'
import type { BrowserNetworkExecutionHost } from '../../shared/browser-client-host-protocol'
import {
  LOCAL_EXECUTION_HOST_ID,
  getWorktreeExecutionHostId,
  parseExecutionHostId
} from '../../shared/execution-host'
import { resolveRuntimeBrowserNetworkExecutionHost } from './runtime-browser-network-execution-host'
import { resolveLocalProjectRuntimeForWorktreeId } from '../local-project-runtime-resolution'
import { getRegisteredSshState } from '../ssh/ssh-target-registry'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../shared/workspace-scope'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import type { Worktree } from '../../shared/worktree/types'
import { folderWorkspaceToWorktree } from '../../shared/folder-workspace-worktree'
import type { TerminalWorkspaceLaunchScope } from './runtime-legacy-worker-terminal-recovery-types'
import type { ResolvedTerminalWorkspaceLaunchTarget } from './orca-runtime-core'
import { homedir } from 'node:os'
import { RuntimeTerminalWorkspaceLaunch } from './terminal/launch/terminal-workspace-launch'
import { RuntimeTerminalExecutionContext } from './terminal/launch/terminal-execution-context'

function withoutWorktreeLineage(worktree: Worktree): ResolvedWorktree {
  return {
    ...worktree,
    parentWorktreeId: null,
    childWorktreeIds: [],
    lineage: null,
    git: {
      path: worktree.path,
      head: worktree.head,
      branch: worktree.branch,
      isBare: worktree.isBare,
      isMainWorktree: worktree.isMainWorktree
    }
  }
}

export class OrcaRuntimeWithResolveBrowserNetworkExecutionHostForWorktree extends TerminalWorkspaceIdValidation {
  protected readonly terminalWorkspaceLaunch = new RuntimeTerminalWorkspaceLaunch({
    resolveTerminalWorkspaceLaunchTarget: () =>
      this.sessionPorts.bindRuntimeMethod(this.resolveTerminalWorkspaceLaunchTarget),
    materializeTerminalPushTarget: (worktree, repo) =>
      triggerTerminalSpawnPushTargetMaterialization(
        worktree.path,
        worktree.pushTarget,
        repo,
        this.store,
        worktree.repoId,
        worktree.id
      ),
    resolveFloatingWorkspacePath: () =>
      this.sessionPorts.bindRuntimeMethod(this.resolveFloatingWorkspacePath),
    resolveFolderWorkspaceLaunchScope: () =>
      this.sessionPorts.bindRuntimeMethod(this.resolveFolderWorkspaceLaunchScope),
    folderWorkspaceToResolvedWorktree: () =>
      this.sessionPorts.bindRuntimeMethod(this.folderWorkspaceToResolvedWorktree),
    getStore: () => this.store,
    resolveWorktreeSelector: () =>
      this.sessionPorts.bindRuntimeMethod(this.resolveWorktreeSelector),
    buildAgentHookPtyEnv: (...args) => this.buildAgentHookPtyEnv?.(...args)
  })
  protected resolveWorkspaceTerminalStartupCwd(
    workspace: Pick<TerminalWorkspaceLaunchScope, 'path'>,
    requestedCwd?: string | null
  ): string | undefined {
    return this.terminalWorkspaceLaunch.resolveWorkspaceTerminalStartupCwd(workspace, requestedCwd)
  }
  protected resolveTerminalWorkspaceLaunchScope(
    selector: string,
    createdWorktree?: Worktree
  ): Promise<TerminalWorkspaceLaunchScope> {
    return this.terminalWorkspaceLaunch.resolveTerminalWorkspaceLaunchScope(
      selector,
      createdWorktree
    )
  }
  protected resolveTerminalWorkspaceLaunchTarget(
    selector: string,
    createdWorktree?: Worktree
  ): Promise<ResolvedTerminalWorkspaceLaunchTarget> {
    return this.terminalWorkspaceLaunch.resolveTerminalWorkspaceLaunchTarget(
      selector,
      createdWorktree
    )
  }
  protected buildTerminalWorkspaceEnv(
    scope: TerminalWorkspaceLaunchScope,
    baseEnv: Record<string, string>,
    paneKey: string,
    tabId: string,
    agentTeamsEnv?: Record<string, string>
  ): Promise<Record<string, string>> {
    return this.terminalWorkspaceLaunch.buildTerminalWorkspaceEnv(
      scope,
      baseEnv,
      paneKey,
      tabId,
      agentTeamsEnv
    )
  }
  protected readonly terminalExecutionContext = new RuntimeTerminalExecutionContext({
    getPtysById: () => this.ptysById,
    getWslDistroByPtyId: () => this.wslDistroByPtyId,
    getEarlyExitedPtyIncarnations: () => this.earlyExitedPtyIncarnations,
    disposeHeadlessTerminal: () =>
      this.sessionPorts.bindRuntimeMethod(this.disposeHeadlessTerminal),
    getOsc7ScanTailByPtyId: () => this.osc7ScanTailByPtyId,
    getTerminalCwdByPtyId: () => this.terminalCwdByPtyId,
    getTerminalFileUriHostnameByPtyId: () => this.terminalFileUriHostnameByPtyId,
    getHeadlessTerminals: () => this.headlessTerminals,
    replaceHeadlessTerminalAfterExecutionContextChange: () =>
      this.sessionPorts.bindRuntimeMethod(this.replaceHeadlessTerminalAfterExecutionContextChange),
    getTerminalSpawnCommandsByPtyId: () => this.terminalSpawnCommandsByPtyId
  })
  preparePtyExecutionContext(
    ptyId: string,
    wslDistro: string | null,
    options: { resetIncarnation?: boolean; preserveExisting?: boolean } = {}
  ): boolean {
    return this.terminalExecutionContext.preparePtyExecutionContext(ptyId, wslDistro, options)
  }
  noteTerminalSpawnCommand(ptyId: string, command: string | null | undefined): void {
    return this.terminalExecutionContext.noteTerminalSpawnCommand(ptyId, command)
  }
  protected resolveBrowserNetworkExecutionHostForWorktree(worktree?: {
    id: string
    repoId?: string
    hostId?: ExecutionHostId
  }): BrowserNetworkExecutionHost | Promise<BrowserNetworkExecutionHost> {
    const repo = worktree?.repoId ? this.requireStore().getRepo(worktree.repoId) : undefined
    const executionHostId = worktree
      ? getWorktreeExecutionHostId(worktree, repo)
      : LOCAL_EXECUTION_HOST_ID
    const parsedHost = parseExecutionHostId(executionHostId)
    return resolveRuntimeBrowserNetworkExecutionHost({
      runtimeId: this.getRuntimeId(),
      runtimeRevision: this.getStartedAt(),
      executionHostId,
      ...(worktree
        ? {
            projectRuntime: resolveLocalProjectRuntimeForWorktreeId(
              this.requireStore(),
              worktree.id
            )
          }
        : {}),
      ...(parsedHost?.kind === 'ssh'
        ? { sshState: getRegisteredSshState(parsedHost.targetId) }
        : {})
    })
  }

  protected async resolveEmulatorCleanupWorkspaceId(selector: string): Promise<string> {
    const workspaceSelector = selector.startsWith('id:') ? selector.slice(3) : selector
    const parsed = parseWorkspaceKey(workspaceSelector)
    return parsed?.type === 'folder'
      ? folderWorkspaceKey(parsed.folderWorkspaceId)
      : this.resolveEmulatorWorkspaceId(selector)
  }

  protected async resolveFloatingWorkspacePath(): Promise<string> {
    const store = this.store
    return store
      ? resolveFloatingTerminalCwd(store, { path: store.getSettings().floatingTerminalCwd })
      : homedir()
  }

  protected floatingWorkspaceToResolvedWorktree(path: string): ResolvedWorktree {
    return withoutWorktreeLineage(floatingWorkspaceToWorktree(path))
  }

  protected folderWorkspaceToResolvedWorktree(folderWorkspace: FolderWorkspace): ResolvedWorktree {
    return withoutWorktreeLineage(folderWorkspaceToWorktree(folderWorkspace))
  }
}
