import type { AgentSessionAccountHome } from './agent-session-account-home'
import type { AiVaultSession, AiVaultListArgs } from './ai-vault-types'
import type { ExecutionHostId } from './execution-host'

export const AI_VAULT_SELECTED_SESSION_CAPABILITY = 'aiVault.selected-session.v1' as const
export const SELECTED_SESSION_LOOKUP_TIMEOUT_MS = 15_000
export const LEGACY_SELECTED_SESSION_LOOKUP_TIMEOUT_MS = 150_000
export const SELECTED_TRANSCRIPT_MAX_BYTES = 16 * 1024 * 1024

export type SelectedCliSessionSource = {
  paneKey: string
  workspaceId: string
}

export type AiVaultSelectedSessionSource =
  | { kind: 'chat'; sessionId: string; workspaceId: string }
  | (SelectedCliSessionSource & {
      kind: 'cli'
      agent: 'claude' | 'codex'
      providerSessionId: string
    })

/** Launch facts shared by a history row and a host's selected conversation. */
export type AiVaultSessionLaunchContext = Pick<
  AiVaultSession,
  | 'agent'
  | 'sessionId'
  | 'executionHostId'
  | 'executionHostPlatform'
  | 'filePath'
  | 'cwd'
  | 'codexHome'
  | 'structuredSession'
  | 'messageCount'
  | 'previewMessages'
  | 'title'
  | 'branch'
> & {
  subagent?: AiVaultSession['subagent']
  accountHome?: AgentSessionAccountHome
  selectedSource?: SelectedCliSessionSource
}

export type AiVaultResolveSessionArgs = {
  source: AiVaultSelectedSessionSource
  executionHostId: ExecutionHostId
  requestToken: string
  /** Compatibility lookup is allowed only when the paired host lacks the capability. */
  legacyHost?: true
  legacyList?: Pick<
    AiVaultListArgs,
    'limit' | 'unlimited' | 'scopePaths' | 'includeAntigravityIdeSessions'
  >
}

export type AiVaultResolveSessionResult =
  | { status: 'ready'; session: AiVaultSessionLaunchContext }
  | { status: 'missing' }
  | { status: 'cancelled' }
