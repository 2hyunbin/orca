import type { AiVaultSessionLaunchContext } from '../../../../shared/ai-vault-selected-session'
// Selects the host-owned source; existing History gates still decide its surface switch.

import type { AppState } from '@/store/types'
import { getIndexedAllWorktrees } from '@/store/worktree-repo-index'
import {
  collectAiVaultTitleRequests,
  resolvePaneAiVaultTitleRequest
} from '@/lib/ai-vault-tab-title-requests'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId,
  type ExecutionHostScope
} from '../../../../shared/execution-host'
import type { AgentSessionHandleProvider } from '../../../../shared/agent-session-provider-handle'
import { agentForksConversations } from '../../../../shared/agent-resume-argv'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { AgentType } from '../../../../shared/agent-status-types'
import { resolveAiVaultSessionSurfaceSwitchTargets } from '../right-sidebar/ai-vault-session-surface-switch'
import { resolveAiVaultHistoryRowResume } from '../right-sidebar/ai-vault-session-resume-in-chat-workspace'
import { resolveAiVaultTargetWorkspacePath } from '../right-sidebar/ai-vault-session-launch-target'
import {
  aiVaultSessionOwnerWorkspaces,
  resolveAiVaultSessionWorktreeDisplay
} from '../right-sidebar/ai-vault-session-worktree'
import type { AiVaultSessionListRequest } from '../right-sidebar/ai-vault-session-list-request'
import { resolveAiVaultPanelSessionListRequest } from '../right-sidebar/ai-vault-panel-session-list-request'
import { resolveAiVaultHostScopeDefaults } from '../right-sidebar/ai-vault-host-scope'
import { getAiVaultResumeWorkspaceExecutionHostId } from '@/lib/ai-vault-resume-target'
import { structuredAgentSessionLaunchFeasible } from '@/lib/agent-session-launch-plan'
import { workspaceKindForWorktreeId } from '../../../../shared/workspace-launch-kind'

/** Identity for selected lookup, with list options reserved for older paired hosts. */
export type TabSessionSelectedSource = {
  workspaceId: string
  executionHostId: ExecutionHostId
  legacyListRequest: AiVaultSessionListRequest
} & (
  | { kind: 'chat'; agent: AgentType; sessionId: string }
  | {
      kind: 'cli'
      agent: AgentSessionHandleProvider
      providerSessionId: string
      paneKey: string
    }
)

export type TabSessionSwitch = {
  action: 'resume-in-new-chat' | 'resume-in-new-cli'
  worktreeId: string
}

/** Skips lookups on hosts where the row's gate can never pass, so no remote scan runs for nothing. */
function canHostOfferTabSessionMove(
  kind: TabSessionSelectedSource['kind'],
  hostScope: ExecutionHostScope
): boolean {
  if (hostScope === LOCAL_EXECUTION_HOST_ID) {
    return true
  }
  // Resume-in-chat refuses any row not recorded on this machine. A chat's row is owned only where an
  // Orca host projects chat ownership: this machine or a runtime server, never an SSH relay.
  return kind === 'chat' && parseExecutionHostId(hostScope)?.kind === 'runtime'
}

/** Whether a pane's running agent has a conversation the move could act on, without building the
 *  list request, for a surface that stays rendered. Host resolution still decides on click. */
export function canPaneOfferResumeInNewChat(
  state: AppState,
  pane: { worktreeId: string; paneKey: string }
): boolean {
  const titleRequest = resolvePaneAiVaultTitleRequest(state, pane)
  if (!titleRequest) {
    return false
  }
  const hostScope = resolveAiVaultHostScopeDefaults(
    getAiVaultResumeWorkspaceExecutionHostId(state, titleRequest.worktreeId),
    titleRequest.worktreeId
  ).defaultExecutionHostScope
  return canHostOfferTabSessionMove('cli', hostScope) && canOpenChatRoute(state, titleRequest)
}

/** The row gate's launch-route half, so a project the chat route refuses (WSL, repair) hides it. */
function canOpenChatRoute(
  state: AppState,
  titleRequest: { agent: AgentSessionHandleProvider; worktreeId: string }
): boolean {
  return structuredAgentSessionLaunchFeasible(state, {
    agent: titleRequest.agent,
    workspace: {
      kind: workspaceKindForWorktreeId(titleRequest.worktreeId),
      worktreeId: titleRequest.worktreeId
    },
    settings: state.settings
  })
}

/** A native chat tab's session and the provider recorded when it was created. */
export type NativeChatTabSession = {
  sessionId: string
  agent: AgentType | undefined
}

export function resolveTabSessionSelectedSource(
  state: AppState,
  args: {
    tab: Pick<TerminalTab, 'id' | 'worktreeId'>
    /** Set only for a native chat tab. */
    nativeChat?: NativeChatTabSession
    /** Narrows a terminal tab to one pane's own conversation instead of the tab's best one. */
    paneKey?: string
  }
): TabSessionSelectedSource | null {
  const workspace = (workspaceId: string, kind: TabSessionSelectedSource['kind']) => {
    if (!resolveAiVaultTargetWorkspacePath(state, workspaceId)) {
      return null
    }
    const request = resolveAiVaultPanelSessionListRequest(state, workspaceId)
    return request.executionHostScope !== 'all' &&
      canHostOfferTabSessionMove(kind, request.executionHostScope)
      ? { workspaceId, executionHostId: request.executionHostScope, legacyListRequest: request }
      : null
  }
  if (args.nativeChat) {
    // A chat tab's only move is opening a copy in its CLI.
    const { agent, sessionId } = args.nativeChat
    const target =
      agent && agentForksConversations(agent) ? workspace(args.tab.worktreeId, 'chat') : null
    return agent && target ? { ...target, kind: 'chat', agent, sessionId } : null
  }
  // The pane-to-conversation mapping tab titles use, limited to agents still running: once the agent
  // exits, the tab title keeps its conversation but the move is no longer offered.
  const titleRequest = args.paneKey
    ? resolvePaneAiVaultTitleRequest(state, {
        worktreeId: args.tab.worktreeId,
        paneKey: args.paneKey
      })
    : (collectAiVaultTitleRequests(state, { runningAgentsOnly: true }).find(
        (candidate) => candidate.tabId === args.tab.id
      ) ?? null)
  const target =
    titleRequest && canOpenChatRoute(state, titleRequest)
      ? workspace(titleRequest.worktreeId, 'cli')
      : null
  return titleRequest?.paneKey && target
    ? {
        ...target,
        kind: 'cli',
        agent: titleRequest.agent,
        providerSessionId: titleRequest.providerSession.id,
        paneKey: titleRequest.paneKey
      }
    : null
}

/** The row's move under the Session History gate, with the tab's own workspace standing in for the
 *  active one. A chat tab only forks into a CLI; a CLI tab only resumes into a chat. */
export function resolveTabSessionSwitch(
  state: AppState,
  session: AiVaultSessionLaunchContext,
  subject: TabSessionSelectedSource
): TabSessionSwitch | null {
  const worktrees = aiVaultSessionOwnerWorkspaces(
    getIndexedAllWorktrees(state.worktreesByRepo),
    state.folderWorkspaces
  )
  const { resumeState, resumeInChat } = resolveAiVaultHistoryRowResume({
    session,
    worktreeInfo: resolveAiVaultSessionWorktreeDisplay({
      session,
      repos: state.repos,
      worktrees,
      activeWorktreeId: subject.workspaceId
    }),
    activeWorktreeId: subject.workspaceId,
    worktrees,
    repos: state.repos,
    targetState: state,
    settings: state.settings
  })
  const targets = resolveAiVaultSessionSurfaceSwitchTargets(session, resumeState, resumeInChat)
  if (subject.kind === 'chat') {
    return targets.resumeInNewCliWorktreeId
      ? {
          action: 'resume-in-new-cli',
          worktreeId: targets.resumeInNewCliWorktreeId
        }
      : null
  }
  return targets.resumeInNewChatWorkspaceId
    ? {
        action: 'resume-in-new-chat',
        worktreeId: targets.resumeInNewChatWorkspaceId
      }
    : null
}
