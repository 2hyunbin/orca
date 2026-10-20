import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { DEFAULT_REPO_BADGE_COLOR } from '../../shared/constants'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import { gitExecFileAsync } from '../git/runner'
import { getRepoName } from '../git/repo'
import { invalidateAuthorizedRootsCache } from '../ipc/registered-worktree-roots-cache'
import { isENOENT } from '../ipc/filesystem-path-containment'
import { admitRepositoryCheckout } from '../repository-checkout-admission'
import { detectRepoIconAndUpstream } from '../repo-icon-autodetect'
import { prepareLocalWorktreeRootForRepo } from '../worktree-root-preparation'
import type { RuntimeStore } from './runtime-store-contract'
import { runtimePathsEqual } from './runtime-worktree-path-identity'
import {
  registerProjectOnWslHost,
  type WslProjectRoutingOptions
} from '../wsl/wsl-project-registration'

type RuntimeRepositoryRegistrationDependencies = {
  getStore: () => RuntimeStore | null
  invalidateResolvedWorktrees: () => void
  invalidateWorktreeScan: (repoId: string) => void
  notifyReposChanged: () => void
}

export class RuntimeRepositoryRegistrationController {
  constructor(private readonly deps: RuntimeRepositoryRegistrationDependencies) {}

  async add(
    path: string,
    kind: 'git' | 'folder' = 'git',
    executionHostId?: ExecutionHostId | null,
    displayName?: string,
    wslRouting: Pick<WslProjectRoutingOptions, 'fromPairedClient'> = {}
  ): Promise<Repo> {
    const store = this.requireStore()
    if (!isAbsolute(path)) {
      throw new Error('Project path must be an absolute path')
    }
    const admission = await admitRepositoryCheckout(store, path, kind, executionHostId)
    const repoPath = admission.registrationPath
    const existing = admission.findSaved()
    if (existing) {
      if (
        existing.executionHostId == null &&
        parseExecutionHostId(executionHostId)?.kind === 'runtime'
      ) {
        const adopted =
          store.updateRepo(existing, { executionHostId }) ??
          ({ ...existing, executionHostId } as Repo)
        this.invalidate(existing.id)
        return adopted
      }
      return existing
    }
    // Why here: a saved Windows row for this checkout stays its owner; only a new one goes to WSL.
    const hosted = await registerProjectOnWslHost(
      store,
      { kind: 'add', path: repoPath, repoKind: kind, displayName },
      { ...wslRouting, executionHostId, admission }
    )
    if (hosted) {
      return hosted
    }
    // Local on purpose, whatever `executionHostId` stamps on the row: this controller already
    // validated and will read `path` in this process. A `runtime:` stamp is how a paired client
    // addresses the row, not a second machine holding the files.
    const detected = await detectRepoIconAndUpstream({
      repoPath,
      kind,
      executionHostId: LOCAL_EXECUTION_HOST_ID
    })
    // Another registration of the same checkout can finish while icon discovery is pending.
    const raceWinner = admission.findSaved()
    if (raceWinner) {
      return raceWinner
    }
    const repo: Repo = {
      id: randomUUID(),
      path: repoPath,
      displayName: displayName?.trim() || getRepoName(repoPath),
      badgeColor: DEFAULT_REPO_BADGE_COLOR,
      ...(executionHostId != null ? { executionHostId } : {}),
      ...detected,
      addedAt: Date.now(),
      kind,
      ...(kind === 'git' ? { externalWorktreeVisibilityLegacy: false } : {})
    }
    store.addRepo(repo)
    await prepareLocalWorktreeRootForRepo(store, repo)
    this.invalidate(repo.id)
    return store.getRepo(repo.id) ?? repo
  }

  async create(
    parentPath: string,
    name: string,
    kind: 'git' | 'folder' = 'git',
    wslRouting: Pick<WslProjectRoutingOptions, 'fromPairedClient'> = {}
  ): Promise<{ repo: Repo } | { error: string }> {
    const store = this.requireStore()
    const trimmedName = name.trim()
    const trimmedParentPath = parentPath.trim()
    const repoKind: 'git' | 'folder' = kind === 'folder' ? 'folder' : 'git'
    if (!trimmedName) {
      return { error: 'Name cannot be empty' }
    }
    if (/[\\/]/.test(trimmedName) || trimmedName === '.' || trimmedName === '..') {
      return { error: 'Name cannot contain slashes or be "." / ".."' }
    }
    if (!trimmedParentPath) {
      return { error: 'Parent directory is required' }
    }
    if (!isAbsolute(trimmedParentPath)) {
      return { error: 'Parent directory must be an absolute path' }
    }
    const targetPath = join(trimmedParentPath, trimmedName)
    const existing = store.getRepos().find((repo) => runtimePathsEqual(repo.path, targetPath))
    if (existing) {
      return { repo: existing }
    }
    const hosted = await registerProjectOnWslHost(
      store,
      { kind: 'create', path: trimmedParentPath, name: trimmedName, repoKind },
      wslRouting
    )
    if (hosted) {
      return { repo: hosted }
    }

    let createdDir = false
    try {
      await mkdir(trimmedParentPath, { recursive: true })
      const existingStat = await stat(targetPath).catch((error: unknown) => {
        if (isENOENT(error)) {
          return null
        }
        throw error
      })
      if (existingStat) {
        if (!existingStat.isDirectory()) {
          return { error: `"${trimmedName}" already exists at this location and is not a folder.` }
        }
        if ((await readdir(targetPath)).length > 0) {
          return { error: `"${trimmedName}" already exists at this location and is not empty.` }
        }
      } else {
        await mkdir(targetPath, { recursive: false })
        createdDir = true
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { error: `Failed to prepare directory: ${message}` }
    }

    if (repoKind === 'git') {
      const error = await this.initializeGitRepo(targetPath, createdDir)
      if (error) {
        return { error }
      }
    }
    const raceWinner = store.getRepos().find((repo) => runtimePathsEqual(repo.path, targetPath))
    if (raceWinner) {
      return { repo: raceWinner }
    }
    const detected = await detectRepoIconAndUpstream({
      repoPath: targetPath,
      kind: repoKind,
      executionHostId: LOCAL_EXECUTION_HOST_ID
    })
    const repo: Repo = {
      id: randomUUID(),
      path: targetPath,
      displayName: trimmedName,
      badgeColor: DEFAULT_REPO_BADGE_COLOR,
      ...detected,
      addedAt: Date.now(),
      kind: repoKind,
      ...(repoKind === 'git' ? { externalWorktreeVisibilityLegacy: false } : {})
    }
    store.addRepo(repo)
    await prepareLocalWorktreeRootForRepo(store, repo)
    invalidateAuthorizedRootsCache()
    this.invalidate(repo.id)
    return { repo: store.getRepo(repo.id) ?? repo }
  }

  private async initializeGitRepo(targetPath: string, createdDir: boolean): Promise<string | null> {
    let step: 'init' | 'commit' = 'init'
    try {
      await gitExecFileAsync(['init'], { cwd: targetPath })
      step = 'commit'
      await gitExecFileAsync(['commit', '--allow-empty', '-m', 'Initial commit'], {
        cwd: targetPath
      })
      return null
    } catch (error) {
      if (createdDir) {
        await rm(targetPath, { recursive: true, force: true }).catch(() => {})
      } else if (step === 'commit') {
        await rm(join(targetPath, '.git'), { recursive: true, force: true }).catch(() => {})
      }
      const message = error instanceof Error ? error.message : String(error)
      if (step === 'commit' && /Please tell me who you are|user\.name|user\.email/i.test(message)) {
        return 'Git author identity is not configured. Run `git config --global user.name "Your Name"` and `git config --global user.email "you@example.com"`, then try again.'
      }
      const label =
        step === 'init' ? 'Failed to initialize git repository' : 'Failed to create initial commit'
      return `${label}: ${message}`
    }
  }

  private requireStore(): RuntimeStore {
    const store = this.deps.getStore()
    if (!store) {
      throw new Error('runtime_unavailable')
    }
    return store
  }

  private invalidate(repoId: string): void {
    this.deps.invalidateResolvedWorktrees()
    this.deps.invalidateWorktreeScan(repoId)
    this.deps.notifyReposChanged()
  }
}
