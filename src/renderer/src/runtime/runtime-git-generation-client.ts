import { translate } from '@/i18n/i18n'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { antigravityGenerationCompatibilityError } from './antigravity-generation-compatibility'
import {
  getRuntimeCommitMessageSettings,
  resolveLocalWorktreePath,
  type RuntimeDiscoverCommitMessageModelsResult,
  type RuntimeGenerateCommitMessageOverrides,
  type RuntimeGenerateCommitMessageResult,
  type RuntimeGeneratePullRequestFieldsOverrides,
  type RuntimeGeneratePullRequestFieldsResult,
  type RuntimeGitContext,
  type RuntimePullRequestGenerationInput
} from './runtime-git-client-context'
import { callRuntimeRpc } from './runtime-rpc-client'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'

export async function generateRuntimeCommitMessage(
  context: RuntimeGitContext,
  overrides?: RuntimeGenerateCommitMessageOverrides,
  isCanceled?: () => boolean
): Promise<RuntimeGenerateCommitMessageResult> {
  if (isCanceled?.()) {
    return {
      success: false,
      error: translate('components.jiraIssueTitleField.canceled', 'Generation canceled.'),
      canceled: true
    }
  }
  const target = context.target
  if (target.kind === 'local' || !context.worktreeId) {
    return window.api.git.generateCommitMessage({
      worktreePath: resolveLocalWorktreePath(context),
      // Why: the workspace suffix is part of the worktree metadata key.
      ...(context.worktreeId ? { worktreeId: context.worktreeId } : {}),
      repoId: context.worktreeId ? getRepoIdFromWorktreeId(context.worktreeId) : undefined,
      connectionId: context.connectionId,
      ...(context.generationId ? { generationId: context.generationId } : {}),
      ...(overrides?.sourceControlAiResolvedParams
        ? { sourceControlAiResolvedParams: overrides.sourceControlAiResolvedParams }
        : {}),
      ...(overrides?.sourceControlAi ? { sourceControlAi: overrides.sourceControlAi } : {}),
      ...(overrides?.agentCmdOverrides ? { agentCmdOverrides: overrides.agentCmdOverrides } : {})
    })
  }
  const compatibilityError = await antigravityGenerationCompatibilityError(
    target.environmentId,
    context,
    'commitMessage',
    overrides
  )
  if (isCanceled?.()) {
    return {
      success: false,
      error: translate('components.jiraIssueTitleField.canceled', 'Generation canceled.'),
      canceled: true
    }
  }
  if (compatibilityError) {
    return { success: false, error: compatibilityError }
  }
  return callRuntimeRpc<RuntimeGenerateCommitMessageResult>(
    target,
    'git.generateCommitMessage',
    {
      worktree: toRuntimeWorktreeSelector(context.worktreeId),
      ...(context.generationId ? { generationId: context.generationId } : {}),
      ...getRuntimeCommitMessageSettings(context.target, context.prefs, context.connectionId),
      ...(overrides?.sourceControlAiResolvedParams
        ? { sourceControlAiResolvedParams: overrides.sourceControlAiResolvedParams }
        : {}),
      ...(overrides?.sourceControlAi ? { sourceControlAi: overrides.sourceControlAi } : {}),
      ...(overrides?.agentCmdOverrides ? { agentCmdOverrides: overrides.agentCmdOverrides } : {})
    },
    { timeoutMs: 75_000, ...(isCanceled ? { isCanceled } : {}) }
  ).catch((error) => {
    if (isCanceled?.()) {
      return {
        success: false,
        error: translate('components.jiraIssueTitleField.canceled', 'Generation canceled.'),
        canceled: true
      }
    }
    throw error
  })
}

export async function discoverRuntimeCommitMessageModels(
  context: RuntimeGitContext,
  agentId: string
): Promise<RuntimeDiscoverCommitMessageModelsResult> {
  const target = context.target
  if (target.kind === 'local' || !context.worktreeId) {
    return window.api.git.discoverCommitMessageModels({
      agentId,
      worktreePath: resolveLocalWorktreePath(context),
      connectionId: context.connectionId
    }) as Promise<RuntimeDiscoverCommitMessageModelsResult>
  }
  return callRuntimeRpc<RuntimeDiscoverCommitMessageModelsResult>(
    target,
    'git.discoverCommitMessageModels',
    {
      worktree: toRuntimeWorktreeSelector(context.worktreeId),
      agentId,
      ...(context.prefs?.agentCmdOverrides
        ? { agentCmdOverrides: context.prefs.agentCmdOverrides }
        : {})
    },
    { timeoutMs: 75_000 }
  )
}

export async function cancelRuntimeGenerateCommitMessage(
  context: RuntimeGitContext
): Promise<void> {
  const target = context.target
  if (target.kind === 'local' || !context.worktreeId) {
    await window.api.git.cancelGenerateCommitMessage({
      worktreePath: resolveLocalWorktreePath(context),
      connectionId: context.connectionId,
      ...(context.generationId ? { generationId: context.generationId } : {})
    })
    return
  }
  await callRuntimeRpc(
    target,
    'git.cancelGenerateCommitMessage',
    {
      worktree: toRuntimeWorktreeSelector(context.worktreeId),
      ...(context.generationId ? { generationId: context.generationId } : {})
    },
    { timeoutMs: 5_000 }
  )
}

export async function generateRuntimePullRequestFields(
  context: RuntimeGitContext,
  input: RuntimePullRequestGenerationInput,
  overrides?: RuntimeGeneratePullRequestFieldsOverrides,
  isCanceled?: () => boolean
): Promise<RuntimeGeneratePullRequestFieldsResult> {
  if (isCanceled?.()) {
    return {
      success: false,
      error: translate('components.jiraIssueTitleField.canceled', 'Generation canceled.'),
      canceled: true
    }
  }
  const target = context.target
  if (target.kind === 'local' || !context.worktreeId) {
    return window.api.git.generatePullRequestFields({
      worktreePath: resolveLocalWorktreePath(context),
      // Why: the workspace suffix is part of the worktree metadata key.
      ...(context.worktreeId ? { worktreeId: context.worktreeId } : {}),
      repoId: context.worktreeId ? getRepoIdFromWorktreeId(context.worktreeId) : undefined,
      connectionId: context.connectionId,
      ...(context.generationId ? { generationId: context.generationId } : {}),
      ...input,
      ...(overrides?.sourceControlAiResolvedParams
        ? { sourceControlAiResolvedParams: overrides.sourceControlAiResolvedParams }
        : {}),
      ...(overrides?.sourceControlAi ? { sourceControlAi: overrides.sourceControlAi } : {}),
      ...(overrides?.agentCmdOverrides ? { agentCmdOverrides: overrides.agentCmdOverrides } : {})
    })
  }
  const compatibilityError = await antigravityGenerationCompatibilityError(
    target.environmentId,
    context,
    'pullRequest',
    overrides
  )
  if (isCanceled?.()) {
    return {
      success: false,
      error: translate('components.jiraIssueTitleField.canceled', 'Generation canceled.'),
      canceled: true
    }
  }
  if (compatibilityError) {
    return { success: false, error: compatibilityError }
  }
  return callRuntimeRpc<RuntimeGeneratePullRequestFieldsResult>(
    target,
    'git.generatePullRequestFields',
    {
      worktree: toRuntimeWorktreeSelector(context.worktreeId),
      ...(context.generationId ? { generationId: context.generationId } : {}),
      ...input,
      ...getRuntimeCommitMessageSettings(context.target, context.prefs, context.connectionId),
      ...(overrides?.sourceControlAiResolvedParams
        ? { sourceControlAiResolvedParams: overrides.sourceControlAiResolvedParams }
        : {}),
      ...(overrides?.sourceControlAi ? { sourceControlAi: overrides.sourceControlAi } : {}),
      ...(overrides?.agentCmdOverrides ? { agentCmdOverrides: overrides.agentCmdOverrides } : {})
    },
    { timeoutMs: 75_000, ...(isCanceled ? { isCanceled } : {}) }
  ).catch((error) => {
    if (isCanceled?.()) {
      return {
        success: false,
        error: translate('components.jiraIssueTitleField.canceled', 'Generation canceled.'),
        canceled: true
      }
    }
    throw error
  })
}

export async function cancelRuntimeGeneratePullRequestFields(
  context: RuntimeGitContext
): Promise<void> {
  const target = context.target
  if (target.kind === 'local' || !context.worktreeId) {
    await window.api.git.cancelGeneratePullRequestFields({
      worktreePath: resolveLocalWorktreePath(context),
      connectionId: context.connectionId,
      ...(context.generationId ? { generationId: context.generationId } : {})
    })
    return
  }
  await callRuntimeRpc(
    target,
    'git.cancelGeneratePullRequestFields',
    {
      worktree: toRuntimeWorktreeSelector(context.worktreeId),
      ...(context.generationId ? { generationId: context.generationId } : {})
    },
    { timeoutMs: 5_000 }
  )
}
