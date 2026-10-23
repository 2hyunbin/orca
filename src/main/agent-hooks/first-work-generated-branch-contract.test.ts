import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'
import { closeTestStores, createStore, testState } from '../persistence-test-harness'
import type { Worktree, GitWorktreeInfo } from '../../shared/worktree/types'
import type { Store } from '../persistence'
import type { Repo } from '../../shared/repo-types'
import type { RuntimeManagedWorktreeCreateArgs } from '../runtime/runtime-managed-worktree-create-types'
import { resolveRuntimeLocalWorktreeCreateCandidate } from '../runtime/runtime-local-worktree-create-candidate'
import { materializeRuntimeLocalWorktree } from '../runtime/runtime-local-worktree-materialization'
import { createWorktreeCreateTimingRecorder } from '../worktree-create-timing'
import { firstWorkRenameDeps } from './first-work-rename-runtime'
import {
  maybeAutoRenameBranchOnFirstWork,
  resetFirstWorkBranchRenameState
} from './first-work-branch-rename'
import { workingEvent, gitResponder } from './first-work-branch-rename-test-harness'
import { RuntimeGitStatusCommands } from '../runtime/runtime-git-status-commands'
import { hostWorktreeTargetForRepo } from '../persistence/host-qualified-worktree-meta'

const mocks = vi.hoisted(() => ({
  git: vi.fn(),
  generate: vi.fn(),
  conflict: vi.fn(async () => null),
  reused: vi.fn(async () => false)
}))
vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => false
  }
}))
vi.mock('../git/runner', () => ({ gitExecFileAsync: mocks.git }))
vi.mock('../git/git-username', () => ({ resolveLocalGitUsername: async () => '' }))
vi.mock('../text-generation/commit-message-text-generation', () => ({
  generateBranchNameFromContext: mocks.generate,
  resolveTextGenerationParams: () => ({ ok: true, params: { agentId: 'claude', model: 'm' } })
}))
vi.mock('../text-generation/commit-message-agent-environment', () => ({
  prepareLocalCommitMessageAgentEnv: async () => ({ ok: true })
}))
vi.mock('../runtime/runtime-worktree-create-git', () => ({
  resolveCreateBranchName: async (_path: string, override: string | undefined, leaf: string) =>
    override ?? leaf,
  canCheckoutExistingLocalBranch: mocks.reused,
  getLocalGitHubPrForBranch: async () => null,
  getSelectedHostedReviewForBranch: async () => null
}))
vi.mock('../git/repo', () => ({ getBranchConflictKind: mocks.conflict }))
vi.mock('../runtime/runtime-worktree-filesystem', () => ({ runtimePathExists: async () => false }))
vi.mock('../git/worktree-shared-directories', () => ({
  resolveWorktreeSharedDirectories: async () => []
}))
vi.mock('../git/worktree-include-file', () => ({ resolveWorktreeIncludePaths: async () => [] }))

const repo: Repo = { id: 'repo1', path: '/repo', displayName: 'Repo', badgeColor: '', addedAt: 1 }
const runtime = {
  getCommitMessageAgentEnvironmentResolvers: () => undefined,
  notifyFolderWorkspaceChanged: vi.fn(),
  notifyBranchRenamed: vi.fn(),
  notifyWorktreeFolderRenamed: vi.fn()
}
let store: Store
let worktreeId: string
let branch: string
let currentWorktree: Worktree & { git: GitWorktreeInfo }

async function create(request: Partial<RuntimeManagedWorktreeCreateArgs>, enabled = true) {
  store.updateSettings({ autoRenameBranchFromWork: enabled, branchPrefix: 'none' })
  const settings = store.getSettings()
  const input = { repoSelector: repo.id, name: '検索ダイアログ', ...request }
  const candidate = await resolveRuntimeLocalWorktreeCreateCandidate({
    request: input,
    repo,
    store,
    settings,
    worktreePathSettings: { workspaceDir: '/worktrees', nestWorkspaces: false },
    workspaceRoot: '/worktrees',
    username: '',
    baseBranch: 'main',
    localWorktreeGitOptions: {}
  })
  branch = candidate.branchName
  const result = await materializeRuntimeLocalWorktree({
    request: input,
    repo,
    store,
    settings,
    ...candidate,
    effectiveCreatedWithAgent: input.createdWithAgent,
    created: {
      path: candidate.worktreePath,
      head: 'abc',
      branch,
      isBare: false,
      isMainWorktree: false
    },
    remoteTrackingBase: null,
    sparseDirectories: [],
    baseBranch: 'main',
    localWorktreeGitOptions: {},
    onMetadataPersisted: () => null,
    timing: createWorktreeCreateTimingRecorder()
  })
  currentWorktree = {
    ...result.worktree,
    git: { path: candidate.worktreePath, head: 'abc', branch, isBare: false, isMainWorktree: false }
  }
  worktreeId = result.worktree.id
  mocks.git.mockImplementation(async (args: string[]) => {
    if (args[0] === 'checkout') {
      return { stdout: '' }
    }
    if (args[0] === 'branch') {
      branch = args.at(-1) ?? ''
      return { stdout: '' }
    }
    return gitResponder({ currentBranch: branch, hasUpstream: false })(args)
  })
  return candidate
}
function deps() {
  return { ...firstWorkRenameDeps(store, runtime), resolveWorktreeIdForTab: () => worktreeId }
}
function meta() {
  return store.getWorktreeMetaForHost(worktreeId, 'local')
}
async function work() {
  await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps())
}

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'sta-11403-'))
  store = createStore()
  store.addRepo(repo)
  mocks.generate.mockReset().mockResolvedValue({ success: true, slug: 'fix-search' })
  mocks.conflict.mockReset().mockResolvedValue(null)
  mocks.reused.mockReset().mockResolvedValue(false)
  mocks.git.mockReset()
  resetFirstWorkBranchRenameState()
})
afterEach(async () => {
  await closeTestStores()
  removeTreeSync(testState.dir)
})

describe('saved generated branch ownership', () => {
  it.each(['検索ダイアログ', 'café', 'Nautilus', 'Search dialog'])(
    'keeps the label %s and renames its saved placeholder after restart',
    async (label) => {
      await create({ name: label, branchNaming: 'automatic', displayNameKind: 'user' })
      expect(branch).toMatch(/^orca-[0-9a-f]{8}$/)
      expect(meta()?.generatedBranch).toBe(branch)
      store.flushOrThrow()
      await closeTestStores()
      store = createStore()
      resetFirstWorkBranchRenameState()
      await work()
      expect(branch).toBe('fix-search')
      expect(meta()).toMatchObject({
        displayName: label,
        displayNameIsPinned: true,
        generatedBranch: null
      })
    }
  )

  it('preserves the new ref after Git succeeds but grant cleanup fails, including after restart', async () => {
    await create({
      branchNaming: 'automatic',
      createdWithAgent: 'claude',
      pendingFirstAgentMessageRename: true
    })
    const snapshot = meta()?.generatedBranch
    const renameDeps = deps()
    renameDeps.clearBranchRenameGrant = () => {
      throw new Error('disk unavailable')
    }
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), renameDeps)
    expect(branch).toBe('fix-search')
    expect(meta()?.generatedBranch).toBe(snapshot)
    store.flushOrThrow()
    await closeTestStores()
    store = createStore()
    resetFirstWorkBranchRenameState()
    await work()
    expect(mocks.generate).toHaveBeenCalledOnce()
    expect(meta()).toMatchObject({ generatedBranch: null, pendingFirstAgentMessageRename: true })
  })

  it.each(['feature/検索', 'feature/café', 'Nautilus', 'orca-12345678'])(
    'never grants a new explicit ref %s, even with automatic intent',
    async (explicit) => {
      await create({ branchNaming: 'automatic', branchNameOverride: explicit })
      await work()
      expect(branch).toBe(explicit)
      expect(meta()?.generatedBranch).toBeNull()
      expect(mocks.generate).not.toHaveBeenCalled()
    }
  )

  it('revokes a same-name explicit choice while generation is running', async () => {
    await create({ branchNaming: 'automatic' })
    const initial = branch
    const checkout = new RuntimeGitStatusCommands({
      resolveRuntimeGitTarget: async () => ({
        worktree: currentWorktree,
        executionHostId: 'local'
      }),
      getRuntimeSettings: () => store.getSettings(),
      relinquishGeneratedBranch: () =>
        store.setWorktreeMeta(hostWorktreeTargetForRepo(worktreeId, repo), {
          generatedBranch: null
        })
    })
    // The provider is real; its checkout uses the same Git boundary as the rename.
    mocks.generate.mockImplementationOnce(async () => {
      await checkout.checkoutRuntimeGitBranch(worktreeId, initial)
      return { success: true, slug: 'fix-search' }
    })
    await work()
    expect(mocks.git).toHaveBeenCalledWith(['checkout', initial, '--'], expect.anything())
    expect(branch).toBe(initial)
    expect(meta()?.generatedBranch).toBeNull()
  })

  it.each(['branch', 'instance', 'label'] as const)(
    'rechecks a concurrent %s change after the final collision lookup',
    async (choice) => {
      await create({ branchNaming: 'automatic' })
      const initial = branch
      const exec = mocks.git.getMockImplementation()
      if (!exec) {
        throw new Error('missing Git boundary')
      }
      mocks.git.mockImplementation(async (args: string[]) => {
        if (args[0] === 'show-ref') {
          if (choice === 'branch') {
            branch = 'manual/検索'
          } else {
            store.setWorktreeMeta(
              hostWorktreeTargetForRepo(worktreeId, repo),
              choice === 'instance'
                ? { instanceId: 'replacement' }
                : { displayName: 'Pinned during generation', displayNameIsPinned: true }
            )
          }
        }
        return exec(args)
      })
      await work()
      expect(branch).toBe(
        choice === 'label' ? 'fix-search' : choice === 'branch' ? 'manual/検索' : initial
      )
      if (choice === 'label') {
        expect(meta()?.displayName).toBe('Pinned during generation')
      } else {
        expect(meta()?.generatedBranch).toBeNull()
      }
    }
  )

  it('grants the legacy generated-seed request but never an adopted explicit branch', async () => {
    const candidate = await create({ name: 'Nautilus', nameWasGenerated: true })
    expect(meta()?.generatedBranch).toBe(candidate.branchName)
    await work()
    expect(branch).toBe('fix-search')
    mocks.reused.mockResolvedValue(true)
    await create({ name: 'Adopted', branchNaming: 'automatic', branchNameOverride: 'Nautilus' })
    expect(meta()?.generatedBranch).toBeNull()
    expect(branch).toBe('Nautilus')
  })

  it('keeps disabled creation on the legacy path and revalidates an inert grant after re-enabling', async () => {
    await create({ branchNaming: 'automatic' }, false)
    expect(branch).toBe('検索ダイアログ')
    expect(meta()?.generatedBranch).toBeNull()
    await create({ branchNaming: 'automatic' })
    const placeholder = branch
    store.updateSettings({ autoRenameBranchFromWork: false })
    await work()
    expect(branch).toBe(placeholder)
    expect(meta()?.generatedBranch).toBe(placeholder)
    store.updateSettings({ autoRenameBranchFromWork: true })
    await work()
    expect(branch).toBe('fix-search')
  })

  it.each([
    { name: 'Nautilus' },
    { name: '検索' },
    { name: 'Nautilus', cliProvenance: { kind: 'created-by-cli' as const, createdAt: 1 } }
  ])('keeps missing intent and explicit CLI names conservative: %j', async (request) => {
    await create(request)
    await work()
    expect(branch).toBe(request.name)
    expect(mocks.generate).not.toHaveBeenCalled()
    store.setWorktreeMeta(hostWorktreeTargetForRepo(worktreeId, repo), {
      generatedBranch: undefined
    })
    resetFirstWorkBranchRenameState()
    await work()
    expect(branch).toBe(request.name)
  })
})
