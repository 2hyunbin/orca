import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FilesystemHandlerContext } from './filesystem/filesystem-handler-context'
import type { LocalGenerationTarget } from '../text-generation/source-control-text-generation-types'
import type { LocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import type { prepareLocalCommitMessageAgentEnv } from '../text-generation/commit-message-agent-environment'

type GenerationArgs = {
  worktreePath: string
  generationId?: string
  connectionId?: string
  base?: string
  title?: string
  body?: string
  draft?: boolean
}
type IpcHandler = (
  event: { sender: { id: number } } | null,
  args: GenerationArgs
) => Promise<unknown>

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  resolvePath: vi.fn(async (requestedPath: string) => requestedPath),
  gitOptions: vi.fn((): LocalProjectWorktreeGitOptions => ({})),
  repo: vi.fn(async () => null),
  staged: vi.fn(),
  draft: vi.fn(),
  template: vi.fn(),
  issue: vi.fn(),
  environment: vi.fn<typeof prepareLocalCommitMessageAgentEnv>(),
  commit: vi.fn(async (_context: unknown, _params: unknown, _target: LocalGenerationTarget) => ({
    success: true,
    message: 'Update readme'
  })),
  review: vi.fn(async (_context: unknown, _params: unknown, _target: LocalGenerationTarget) => ({
    success: true,
    fields: { title: 'Update readme', body: 'Details', draft: false }
  })),
  cancelCommit: vi.fn(),
  cancelReview: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => mocks.handlers.set(channel, handler)
  }
}))
vi.mock('./registered-worktree-roots-cache', () => ({
  resolveRegisteredWorktreePath: mocks.resolvePath
}))
vi.mock('./local-worktree-runtime-options', () => ({
  getLocalGitOptionsForRegisteredWorktree: mocks.gitOptions
}))
vi.mock('../git/status', () => ({ getStagedCommitContext: mocks.staged }))
vi.mock('../git/runner', () => ({ gitExecFileAsync: vi.fn() }))
vi.mock('../text-generation/pull-request-context', () => ({
  getPullRequestDraftContext: mocks.draft
}))
vi.mock('../source-control/pull-request-template', () => ({
  resolveHostedReviewBodyForGeneration: mocks.template
}))
vi.mock('../source-control/pull-request-linked-issue', () => ({
  loadPullRequestLinkedIssue: mocks.issue
}))
vi.mock('../text-generation/commit-message-agent-environment', () => ({
  prepareLocalCommitMessageAgentEnv: mocks.environment
}))
vi.mock('../text-generation/commit-message-text-generation', () => ({
  resolveCommitMessageSettings: () => ({
    ok: true,
    params: { agentId: 'codex', model: 'test-model' }
  }),
  generateCommitMessageFromContext: mocks.commit,
  generatePullRequestFieldsFromContext: mocks.review,
  cancelGenerateCommitMessageLocal: mocks.cancelCommit,
  cancelGeneratePullRequestFieldsLocal: mocks.cancelReview
}))
vi.mock('./source-control-ai-linked-issue', () => ({
  resolveSourceControlAiLinkedIssue: () => undefined,
  resolveSourceControlAiLinkedIssueMeta: () => undefined
}))
vi.mock('./filesystem/filesystem-source-control-ai-targets', () => ({
  getRepoForSourceControlAi: mocks.repo,
  getLocalAgentRuntimeTarget: (options: LocalProjectWorktreeGitOptions) =>
    options.wslDistro ? { runtime: 'wsl', wslDistro: options.wslDistro } : { runtime: 'host' },
  getLocalTextGenerationTarget: (
    cwd: string,
    options: LocalProjectWorktreeGitOptions,
    env?: NodeJS.ProcessEnv
  ) => ({ kind: 'local', cwd, ...options, ...(env ? { env } : {}) })
}))

import { registerFilesystemGitCommitGenerationHandlers } from './filesystem/filesystem-git-commit-generation-handlers'
import { registerFilesystemGitPullRequestGenerationHandlers } from './filesystem/filesystem-git-pull-request-generation-handlers'
import {
  cancelLocalGeneration,
  clearLocalGenerationCancelToken,
  getLocalGenerationRequest,
  localGenerationLaneKey,
  setLocalGenerationCancelToken
} from '../text-generation/source-control-generation-lanes'
import { SSH_HOST_NOT_SERVED_MESSAGE } from '../providers/ssh-host-not-served-error'

const event = { sender: { id: 17 } }
const cwd = '/registered/worktree'
const stagedContext = { branch: 'feature', stagedSummary: 'M\tREADME.md', stagedPatch: '+hello' }
const draftContext = {
  branch: 'feature',
  base: 'main',
  branchChangedByPreparation: false,
  currentTitle: '',
  currentBody: '',
  currentDraft: false,
  commitSummary: '- Update',
  changeSummary: 'M\tREADME.md',
  patch: '+hello'
}
const reviewInput = { base: 'main', title: '', body: '', draft: false }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((success, failure) => {
    resolve = success
    reject = failure
  })
  return { promise, resolve, reject }
}

function call(channel: string, args: GenerationArgs, sender = event) {
  const handler = mocks.handlers.get(channel)
  if (!handler) {
    throw new Error(`Missing handler: ${channel}`)
  }
  return handler(sender, args)
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.handlers.clear()
  mocks.resolvePath.mockImplementation(async (requestedPath) => requestedPath)
  mocks.gitOptions.mockReturnValue({})
  mocks.repo.mockResolvedValue(null)
  mocks.staged.mockResolvedValue(stagedContext)
  mocks.draft.mockResolvedValue(draftContext)
  mocks.template.mockResolvedValue('')
  mocks.issue.mockResolvedValue(null)
  mocks.environment.mockResolvedValue({ ok: true })
  mocks.cancelCommit.mockImplementation((path: string) =>
    cancelLocalGeneration('commit-message', path)
  )
  mocks.cancelReview.mockImplementation((path: string) =>
    cancelLocalGeneration('pull-request-fields', path)
  )
  const stub = { store: { getSettings: () => ({}) } }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: mocked preparation only reads store.getSettings from this context.
  const context = stub as unknown as FilesystemHandlerContext
  registerFilesystemGitCommitGenerationHandlers(context)
  registerFilesystemGitPullRequestGenerationHandlers(context)
})

describe.each([
  {
    name: 'commit',
    generate: 'git:generateCommitMessage',
    stop: 'git:cancelGenerateCommitMessage',
    operation: 'commit-message' as const,
    prepare: mocks.staged,
    generator: mocks.commit,
    context: stagedContext,
    input: {}
  },
  {
    name: 'review',
    generate: 'git:generatePullRequestFields',
    stop: 'git:cancelGeneratePullRequestFields',
    operation: 'pull-request-fields' as const,
    prepare: mocks.draft,
    generator: mocks.review,
    context: draftContext,
    input: reviewInput
  }
])(
  '$name generation request cancellation',
  ({ generate, stop, operation, prepare, generator, context, input }) => {
    it.each(['', ' \t ', 'x'.repeat(129)])(
      'rejects malformed ID %j before preparation or legacy cancellation',
      async (generationId) => {
        const args = { worktreePath: cwd, generationId, ...input }
        await expect(call(generate, args)).rejects.toThrow('Invalid generation request ID.')
        await expect(call(stop, args)).rejects.toThrow('Invalid generation request ID.')
        expect(mocks.resolvePath).not.toHaveBeenCalled()
        expect(prepare).not.toHaveBeenCalled()
        expect(generator).not.toHaveBeenCalled()
        expect(mocks.cancelCommit).not.toHaveBeenCalled()
        expect(mocks.cancelReview).not.toHaveBeenCalled()
      }
    )

    it('rejects a duplicate active identity without replacing the first request', async () => {
      const gate = deferred<typeof context>()
      prepare.mockReturnValueOnce(gate.promise)
      const args = { worktreePath: cwd, generationId: 'duplicate', ...input }
      const first = call(generate, args)
      try {
        await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce())
        const identity = { owner: 'window:17', generationId: 'duplicate' }
        const request = getLocalGenerationRequest(operation, identity)
        expect(request).toBeDefined()
        await expect(call(generate, args)).rejects.toThrow(
          'This generation request is already running.'
        )
        expect(getLocalGenerationRequest(operation, identity)).toBe(request)
        expect(prepare).toHaveBeenCalledOnce()
        await call(stop, args)
        expect(request?.canceled).toBe(true)
        gate.resolve(context)
        await expect(first).resolves.toMatchObject({ canceled: true })
        expect(generator).not.toHaveBeenCalled()
      } finally {
        gate.resolve(context)
        await first
      }
    })

    it('keeps omitted-ID legacy cancellation separate from a live identified request', async () => {
      const gate = deferred<typeof context>()
      prepare.mockReturnValueOnce(gate.promise)
      const legacyCancel = vi.fn()
      const lane = localGenerationLaneKey(operation, cwd)
      setLocalGenerationCancelToken(lane, legacyCancel)
      const args = { worktreePath: cwd, generationId: 'alongside-legacy', ...input }
      const result = call(generate, args)
      try {
        await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce())
        const identity = { owner: 'window:17', generationId: 'alongside-legacy' }
        const request = getLocalGenerationRequest(operation, identity)
        await call(stop, { worktreePath: cwd })
        expect(legacyCancel).toHaveBeenCalledOnce()
        expect(request?.canceled).toBe(false)
        legacyCancel.mockClear()
        await call(stop, args)
        expect(legacyCancel).not.toHaveBeenCalled()
        expect(request?.canceled).toBe(true)
        gate.resolve(context)
        await expect(result).resolves.toMatchObject({ canceled: true })
        expect(generator).not.toHaveBeenCalled()
      } finally {
        gate.resolve(context)
        await result
        clearLocalGenerationCancelToken(lane, legacyCancel)
      }
    })

    it('stops after held Git preparation without entering environment or generation', async () => {
      const gate = deferred<typeof context>()
      prepare.mockReturnValueOnce(gate.promise)
      const args = { worktreePath: cwd, generationId: 'context', ...input }
      const result = call(generate, args)
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce())
      await call(stop, args)
      gate.resolve(context)
      await expect(result).resolves.toMatchObject({ success: false, canceled: true })
      expect(mocks.environment).not.toHaveBeenCalled()
      expect(generator).not.toHaveBeenCalled()
      expect(
        getLocalGenerationRequest(operation, { owner: 'window:17', generationId: 'context' })
      ).toBeUndefined()
    })

    it('stops after held environment preparation without entering generation', async () => {
      const gate = deferred<Awaited<ReturnType<typeof prepareLocalCommitMessageAgentEnv>>>()
      mocks.environment.mockReturnValueOnce(gate.promise)
      const args = { worktreePath: cwd, generationId: 'environment', ...input }
      const result = call(generate, args)
      await vi.waitFor(() => expect(mocks.environment).toHaveBeenCalledOnce())
      await call(stop, args)
      gate.resolve({ ok: true })
      await expect(result).resolves.toMatchObject({ success: false, canceled: true })
      expect(generator).not.toHaveBeenCalled()
    })

    it('remembers Stop on a live request while Generate path authorization is pending', async () => {
      const targetPath = deferred<string>()
      mocks.resolvePath.mockReturnValueOnce(targetPath.promise)
      const args = { worktreePath: cwd, generationId: 'pending-target', ...input }
      const result = call(generate, args)
      await vi.waitFor(() => expect(mocks.resolvePath).toHaveBeenCalledOnce())
      await call(stop, args)
      targetPath.resolve(cwd)
      await expect(result).resolves.toMatchObject({ canceled: true })
      expect(prepare).not.toHaveBeenCalled()
      expect(generator).not.toHaveBeenCalled()
    })

    it('cannot undo matching pending Stop with a later Stop for another authorized path', async () => {
      const targetPath = deferred<string>()
      mocks.resolvePath.mockReturnValueOnce(targetPath.promise)
      const args = { worktreePath: cwd, generationId: 'pending-multiple-stops', ...input }
      const result = call(generate, args)
      try {
        await vi.waitFor(() => expect(mocks.resolvePath).toHaveBeenCalledOnce())
        await call(stop, args)
        await call(stop, { ...args, worktreePath: '/another/registered/worktree' })
        targetPath.resolve(cwd)
        await expect(result).resolves.toMatchObject({ canceled: true })
        expect(prepare).not.toHaveBeenCalled()
        expect(generator).not.toHaveBeenCalled()
      } finally {
        targetPath.resolve(cwd)
        await result
      }
    })

    it('captures Stop A before its path wait so later B stays alive', async () => {
      const contextA = deferred<typeof context>()
      const contextB = deferred<typeof context>()
      const stopPath = deferred<string>()
      prepare.mockReturnValueOnce(contextA.promise).mockReturnValueOnce(contextB.promise)
      const argsA = { worktreePath: cwd, generationId: 'A', ...input }
      const argsB = { worktreePath: cwd, generationId: 'B', ...input }
      const first = call(generate, argsA)
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce())
      mocks.resolvePath.mockReturnValueOnce(stopPath.promise)
      const stopped = call(stop, argsA)
      const second = call(generate, argsB)
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(2))
      stopPath.resolve(cwd)
      await stopped
      contextA.resolve(context)
      await expect(first).resolves.toMatchObject({ canceled: true })
      expect(
        getLocalGenerationRequest(operation, { owner: 'window:17', generationId: 'B' })?.canceled
      ).toBe(false)
      contextB.resolve(context)
      await expect(second).resolves.toMatchObject({ success: true })
      expect(generator).toHaveBeenCalledOnce()
    })

    it('isolates exact requests by window, path and WSL runtime', async () => {
      const gate = deferred<typeof context>()
      prepare.mockReturnValueOnce(gate.promise)
      const args = { worktreePath: cwd, generationId: 'isolation', ...input }
      const result = call(generate, args)
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce())
      await call(stop, args, { sender: { id: 18 } })
      await call(stop, { ...args, worktreePath: '/another/worktree' })
      mocks.gitOptions.mockReturnValueOnce({ wslDistro: 'Ubuntu' })
      await call(stop, args)
      expect(
        getLocalGenerationRequest(operation, { owner: 'window:17', generationId: 'isolation' })
          ?.canceled
      ).toBe(false)
      gate.resolve(context)
      await expect(result).resolves.toMatchObject({ success: true })
    })

    it('preserves environment errors and releases the request', async () => {
      mocks.environment.mockResolvedValueOnce({ ok: false, error: 'Account unavailable' })
      await expect(
        call(generate, { worktreePath: cwd, generationId: 'env-error', ...input })
      ).resolves.toEqual({ success: false, error: 'Account unavailable' })
      expect(generator).not.toHaveBeenCalled()
      expect(
        getLocalGenerationRequest(operation, { owner: 'window:17', generationId: 'env-error' })
      ).toBeUndefined()
    })

    it('preserves uncanceled preparation failures and empty-context results', async () => {
      const errorMessage =
        operation === 'commit-message' ? 'Failed to read staged changes.' : 'Git preparation failed'
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        prepare.mockRejectedValueOnce(new Error('Git preparation failed'))
        await expect(
          call(generate, { worktreePath: cwd, generationId: 'context-error', ...input })
        ).resolves.toEqual({ success: false, error: errorMessage })
        prepare.mockResolvedValueOnce(null)
        await expect(
          call(generate, { worktreePath: cwd, generationId: 'no-changes', ...input })
        ).resolves.toEqual({
          success: false,
          error:
            operation === 'commit-message'
              ? 'No staged changes to summarize.'
              : 'No branch changes to summarize.'
        })
        expect(mocks.environment).not.toHaveBeenCalled()
        expect(generator).not.toHaveBeenCalled()
      } finally {
        errorLog.mockRestore()
      }
    })

    it('preserves the legacy target and surviving selected-account environment', async () => {
      const env = { CODEX_HOME: '/selected/account/home' }
      mocks.environment.mockResolvedValueOnce({ ok: true, env })
      mocks.gitOptions.mockReturnValueOnce({ wslDistro: 'Ubuntu' })
      await expect(call(generate, { worktreePath: cwd, ...input })).resolves.toMatchObject({
        success: true
      })
      expect(generator).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
        kind: 'local',
        cwd,
        wslDistro: 'Ubuntu',
        env
      })
    })

    it('does not fall back to a legacy path token when the exact ID is gone', async () => {
      const gate = deferred<typeof context>()
      prepare.mockReturnValueOnce(gate.promise)
      const args = { worktreePath: cwd, generationId: 'new-request', ...input }
      const result = call(generate, args)
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce())
      await call(stop, { ...args, generationId: 'old-request' })
      expect(mocks.cancelCommit).not.toHaveBeenCalled()
      expect(mocks.cancelReview).not.toHaveBeenCalled()
      gate.resolve(context)
      await expect(result).resolves.toMatchObject({ success: true })
    })

    it('keeps legacy Stop and direct SSH behavior', async () => {
      await call(stop, { worktreePath: cwd })
      const legacyCancel = operation === 'commit-message' ? mocks.cancelCommit : mocks.cancelReview
      expect(legacyCancel).toHaveBeenCalledWith(cwd)
      legacyCancel.mockClear()
      await call(stop, { worktreePath: cwd, generationId: 'ssh', connectionId: 'ssh-host' })
      await expect(
        call(generate, {
          worktreePath: cwd,
          generationId: 'ssh',
          connectionId: 'ssh-host',
          ...input
        })
      ).resolves.toEqual({ success: false, error: SSH_HOST_NOT_SERVED_MESSAGE })
      expect(legacyCancel).not.toHaveBeenCalled()
      expect(generator).not.toHaveBeenCalled()
    })
  }
)

it('stops review during template preparation while observing a linked-issue rejection', async () => {
  const template = deferred<string>()
  const issue = deferred<null>()
  mocks.template.mockReturnValueOnce(template.promise)
  mocks.issue.mockReturnValueOnce(issue.promise)
  const args = { worktreePath: cwd, generationId: 'template', ...reviewInput }
  const result = call('git:generatePullRequestFields', args)
  await vi.waitFor(() => expect(mocks.template).toHaveBeenCalledOnce())
  await call('git:cancelGeneratePullRequestFields', args)
  template.resolve('Template')
  issue.reject(new Error('Issue fetch failed'))
  await expect(result).resolves.toMatchObject({ canceled: true })
  expect(mocks.draft).not.toHaveBeenCalled()
  expect(mocks.review).not.toHaveBeenCalled()
})

it('preserves review preparation metadata when Stop arrives during linked-issue lookup', async () => {
  const issue = deferred<null>()
  mocks.issue.mockReturnValueOnce(issue.promise)
  mocks.draft.mockResolvedValueOnce({ ...draftContext, branchChangedByPreparation: true })
  const args = { worktreePath: cwd, generationId: 'linked-issue', ...reviewInput }
  const result = call('git:generatePullRequestFields', args)
  await vi.waitFor(() => expect(mocks.draft).toHaveBeenCalledOnce())
  await call('git:cancelGeneratePullRequestFields', args)
  issue.resolve(null)
  await expect(result).resolves.toEqual({
    success: false,
    error: 'Generation canceled.',
    canceled: true,
    branchChangedByPreparation: true
  })
  expect(mocks.environment).not.toHaveBeenCalled()
})
