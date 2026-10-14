import { ipcMain } from 'electron'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { ResolvedSourceControlAiGenerationParams } from '../../../shared/source-control-ai'
import {
  cancelGenerateCommitMessageLocal,
  generateCommitMessageFromContext,
  resolveCommitMessageSettings,
  type GenerateCommitMessageResult
} from '../../text-generation/commit-message-text-generation'
import { getCommitMessageModelDiscoveryHostKey } from '../../../shared/commit-message-host-key'
import { getStagedCommitContext } from '../../git/status'
import { SSH_HOST_NOT_SERVED_MESSAGE } from '../../providers/ssh-host-not-served-error'
import { resolveRegisteredWorktreePath } from '../registered-worktree-roots-cache'
import { getLocalGitOptionsForRegisteredWorktree } from '../local-worktree-runtime-options'
import { withLinkedIssueDraftContext } from '../../../shared/source-control-ai-action-variables'
import { resolveSourceControlAiLinkedIssue } from '../source-control-ai-linked-issue'
import { prepareLocalCommitMessageAgentEnv } from '../../text-generation/commit-message-agent-environment'
import {
  beginLocalGenerationRequest,
  getLocalGenerationRequest
} from '../../text-generation/source-control-generation-lanes'
import type { FilesystemHandlerContext } from './filesystem-handler-context'
import {
  getLocalAgentRuntimeTarget,
  getLocalTextGenerationTarget,
  getRepoForSourceControlAi
} from './filesystem-source-control-ai-targets'

export function registerFilesystemGitCommitGenerationHandlers(
  context: FilesystemHandlerContext
): void {
  const { store, commitMessageAgentEnv } = context
  ipcMain.handle(
    'git:generateCommitMessage',
    async (
      event,
      args: {
        worktreePath: string
        // Raw (unstripped) meta key; validated against worktreePath before any meta read.
        worktreeId?: string
        repoId?: string
        connectionId?: string
        generationId?: string
        sourceControlAiResolvedParams?: ResolvedSourceControlAiGenerationParams
        sourceControlAi?: GlobalSettings['sourceControlAi']
        agentCmdOverrides?: GlobalSettings['agentCmdOverrides']
      }
    ): Promise<GenerateCommitMessageResult> => {
      const request = beginLocalGenerationRequest(
        'commit-message',
        args.generationId === undefined
          ? undefined
          : { owner: `window:${event.sender.id}`, generationId: args.generationId }
      )
      try {
        const discoveryHostKey = getCommitMessageModelDiscoveryHostKey(args.connectionId ?? null)
        const baseSettings = store.getSettings()
        const requestSettings = {
          ...baseSettings,
          ...(args.sourceControlAi !== undefined ? { sourceControlAi: args.sourceControlAi } : {}),
          ...(args.agentCmdOverrides !== undefined
            ? { agentCmdOverrides: args.agentCmdOverrides }
            : {})
        }
        const repo = args.sourceControlAiResolvedParams
          ? null
          : await getRepoForSourceControlAi(store, args)
        if (request?.canceled) {
          return { success: false, error: 'Generation canceled.', canceled: true }
        }
        const resolvedSettings = args.sourceControlAiResolvedParams
          ? { ok: true as const, params: args.sourceControlAiResolvedParams }
          : resolveCommitMessageSettings(requestSettings, discoveryHostKey, 'commitMessage', repo)
        if (!resolvedSettings.ok) {
          return { success: false, error: resolvedSettings.error }
        }
        if (args.connectionId) {
          return { success: false, error: SSH_HOST_NOT_SERVED_MESSAGE }
        }
        const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
        const gitOptions = getLocalGitOptionsForRegisteredWorktree(
          store,
          args.worktreePath,
          worktreePath
        )
        if (request) {
          request.bindTarget(getLocalTextGenerationTarget(worktreePath, gitOptions))
        }
        if (request?.canceled) {
          return { success: false, error: 'Generation canceled.', canceled: true }
        }
        let context
        try {
          context = await getStagedCommitContext(worktreePath, {
            ...gitOptions,
            admissionTier: 'interactive'
          })
        } catch (error) {
          console.error('[filesystem] Failed to read staged commit context:', error)
          return {
            success: false,
            error: 'Failed to read staged changes.'
          }
        }
        if (request?.canceled) {
          return { success: false, error: 'Generation canceled.', canceled: true }
        }
        if (!context) {
          return { success: false, error: 'No staged changes to summarize.' }
        }
        context = withLinkedIssueDraftContext(
          context,
          resolveSourceControlAiLinkedIssue(store, args, worktreePath)
        )
        const localEnv = await prepareLocalCommitMessageAgentEnv(
          resolvedSettings.params.agentId,
          commitMessageAgentEnv,
          getLocalAgentRuntimeTarget(gitOptions)
        )
        if (request?.canceled) {
          return { success: false, error: 'Generation canceled.', canceled: true }
        }
        if (!localEnv.ok) {
          return { success: false, error: localEnv.error }
        }
        return await generateCommitMessageFromContext(context, resolvedSettings.params, {
          ...getLocalTextGenerationTarget(worktreePath, gitOptions, localEnv.env),
          ...(request ? { generationRequest: request } : {})
        })
      } finally {
        request?.release()
      }
    }
  )

  ipcMain.handle(
    'git:cancelGenerateCommitMessage',
    async (
      event,
      args: { worktreePath: string; connectionId?: string; generationId?: string }
    ): Promise<void> => {
      if (args.connectionId) {
        return
      }
      const request =
        args.generationId === undefined
          ? undefined
          : getLocalGenerationRequest('commit-message', {
              owner: `window:${event.sender.id}`,
              generationId: args.generationId
            })
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      if (args.generationId !== undefined) {
        const gitOptions = getLocalGitOptionsForRegisteredWorktree(
          store,
          args.worktreePath,
          worktreePath
        )
        request?.cancelForTarget(getLocalTextGenerationTarget(worktreePath, gitOptions))
        return
      }
      cancelGenerateCommitMessageLocal(worktreePath)
    }
  )
}
