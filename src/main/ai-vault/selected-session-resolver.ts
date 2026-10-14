import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type {
  AiVaultSelectedSessionSource,
  AiVaultResolveSessionResult
} from '../../shared/ai-vault-selected-session'
import { agentSessionProviderHandleChainHead } from '../../shared/agent-session-provider-handle'
import { isLegacyAgentSessionAccountHome } from '../../shared/agent-session-account-home'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { AI_VAULT_AGENTS } from '../../shared/ai-vault-types'
import {
  isLegacySharedCodexHome,
  isPerAccountManagedCodexHome
} from '../../shared/ai-vault-resume-preparation'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { listStructuredProviderSessionOwnership } from '../native-chat/agent-session-wire/structured-provider-session-ownership'
import { structuredAgentRuntimeRegistration } from '../runtime/structured-agent-runtime-registrations'
import { agentSessionPinnedLaunchDirectory } from '../runtime/agent-session-record-launch-directory'
import {
  resolveSelectedAccountTranscript,
  resolveSelectedCliTranscript,
  selectedCliSourceStatus
} from '../native-chat/selected-cli-transcript'
import { readSelectedSessionInBackground } from './selected-session-reader-client'
import {
  findStructuredAiVaultOwnership,
  projectStructuredAiVaultSessions,
  OPENS_EVERY_STRUCTURED_CHAT
} from './structured-session-ownership'
import { withSelectedSessionDeadline } from './selected-session-deadline'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import type { StructuredAgentTranscriptImportSettings } from '../native-chat/structured-agent-cli-conversations'
import { isAgentSessionRefusalError } from '../../shared/agent-session-wire-refusals'

export type SelectedSessionRuntime = Pick<
  OrcaRuntimeService,
  | 'ensureStructuredAgentSessionHost'
  | 'getAgentProviderSessionRows'
  | 'resolveStructuredAgentAccountHome'
  | 'resolveStructuredAgentSessionLocalWorkspacePath'
>

export function resolveSelectedSessionOnHost(
  source: AiVaultSelectedSessionSource,
  runtime: SelectedSessionRuntime,
  settings: StructuredAgentTranscriptImportSettings,
  signal?: AbortSignal
): Promise<AiVaultResolveSessionResult> {
  return withSelectedSessionDeadline(async (owned) => {
    await waitForPromiseWithSignal(runtime.ensureStructuredAgentSessionHost(), owned)
    const workspacePath = await runtime.resolveStructuredAgentSessionLocalWorkspacePath(
      source.workspaceId
    )
    owned.throwIfAborted()
    if (!workspacePath) {
      throw new Error('The conversation workspace is unavailable on this host.')
    }
    try {
      return source.kind === 'chat'
        ? await resolveChat(source, settings, workspacePath, owned)
        : await resolveCli(source, runtime, settings, workspacePath, owned)
    } catch (error) {
      if (
        isAgentSessionRefusalError(error) &&
        error.refusal.details?.reason === 'transcriptNotFound'
      ) {
        return { status: 'missing' }
      }
      throw error
    }
  }, signal)
}

async function resolveChat(
  source: Extract<AiVaultSelectedSessionSource, { kind: 'chat' }>,
  settings: StructuredAgentTranscriptImportSettings,
  workspacePath: string,
  signal: AbortSignal
): Promise<AiVaultResolveSessionResult> {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    throw new Error('The source chat is unavailable on this host.')
  }
  const currentRecord = () => {
    const record = host.deps.store.getRecord(source.sessionId)
    if (
      !record ||
      record.location.workspaceId !== source.workspaceId ||
      record.location.executionHostId !== LOCAL_EXECUTION_HOST_ID ||
      record.location.wslDistro
    ) {
      throw new Error('The source chat is unavailable on this host.')
    }
    return record
  }
  currentRecord()
  const snapshot = await waitForPromiseWithSignal(host.journalSnapshot(source.sessionId), signal)
  const record = currentRecord()
  const agent = AI_VAULT_AGENTS.find((candidate) => candidate === record.provider)
  const head = agentSessionProviderHandleChainHead(record.providerHandleChain)
  const history = structuredAgentRuntimeRegistration(record.provider)?.sessionHistory
  if (!agent || !history || !head || !isLegacyAgentSessionAccountHome(record.accountHome)) {
    throw new Error('This chat has no saved provider conversation to open.')
  }
  const sessionId = history.rowSessionId(head)
  const owner = listStructuredProviderSessionOwnership([record]).find(
    (candidate) => candidate.providerSessionId === sessionId
  )
  if (!owner) {
    throw new Error('The source conversation ownership could not be verified.')
  }
  const messageCount = snapshot.items.filter(
    (item) =>
      item.body.kind === 'message' && (item.body.role === 'user' || item.body.role === 'assistant')
  ).length
  const cwd = agentSessionPinnedLaunchDirectory(record) ?? workspacePath
  let filePath = agent === 'pi' ? head.handle.nativeId : ''
  const codexHome = agent === 'codex' ? record.accountHome.path : null
  if (
    agent === 'codex' &&
    (isLegacySharedCodexHome(codexHome) || isPerAccountManagedCodexHome(codexHome))
  ) {
    const resolved = await resolveSelectedAccountTranscript({
      agent,
      providerSessionId: sessionId,
      selectedAccountHomePath: record.accountHome.path,
      settings,
      cwd,
      signal
    })
    filePath = resolved.transcriptPath
  }
  signal.throwIfAborted()
  return {
    status: 'ready',
    session: {
      agent,
      sessionId,
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      executionHostPlatform: process.platform,
      filePath,
      cwd,
      codexHome,
      accountHome: record.accountHome,
      title: record.conversationName ?? '',
      branch: null,
      messageCount,
      previewMessages: [],
      structuredSession: { sessionId: owner.sessionId, workspaceId: owner.workspaceId }
    }
  }
}

async function resolveCli(
  source: Extract<AiVaultSelectedSessionSource, { kind: 'cli' }>,
  runtime: SelectedSessionRuntime,
  settings: StructuredAgentTranscriptImportSettings,
  cwd: string,
  signal: AbortSignal
): Promise<AiVaultResolveSessionResult> {
  const owned = selectedCliOwnedSession(source, runtime)
  if (owned) {
    return owned
  }
  const selected = await runtime.resolveStructuredAgentAccountHome(source.agent)
  const afterAccount = selectedCliOwnedSession(source, runtime)
  if (afterAccount) {
    return afterAccount
  }
  if (!isLegacyAgentSessionAccountHome(selected)) {
    throw new Error('Conversation account is unavailable.')
  }
  const resolved = await resolveSelectedCliTranscript({
    agent: source.agent,
    providerSessionId: source.providerSessionId,
    source,
    rows: runtime.getAgentProviderSessionRows(),
    selectedAccountHomePath: selected.path,
    settings,
    cwd,
    signal
  })
  const beforeRead = selectedCliOwnedSession(source, runtime)
  if (beforeRead) {
    return beforeRead
  }
  const row = await readSelectedSessionInBackground(
    {
      agent: source.agent,
      filePath: resolved.transcriptPath,
      codexHome: source.agent === 'codex' ? resolved.accountHomePath : null
    },
    signal
  )
  const afterRead = selectedCliOwnedSession(source, runtime)
  if (afterRead) {
    return afterRead
  }
  if (!row) {
    return { status: 'missing' }
  }
  const projected = projectStructuredAiVaultSessions(
    {
      sessions: [{ ...row, sessionId: source.providerSessionId }],
      issues: [],
      scannedAt: new Date().toISOString()
    },
    OPENS_EVERY_STRUCTURED_CHAT
  ).sessions[0]
  if (!projected) {
    throw new Error('Conversation ownership is unavailable to this client.')
  }
  return {
    status: 'ready',
    session: {
      ...projected,
      accountHome: { variable: selected.variable, path: resolved.accountHomePath },
      selectedSource: { paneKey: source.paneKey, workspaceId: source.workspaceId }
    }
  }
}

function selectedCliOwnedSession(
  source: Extract<AiVaultSelectedSessionSource, { kind: 'cli' }>,
  runtime: SelectedSessionRuntime
): AiVaultResolveSessionResult | null {
  selectedCliSourceStatus({
    agent: source.agent,
    providerSessionId: source.providerSessionId,
    source,
    rows: runtime.getAgentProviderSessionRows()
  })
  const owner = findStructuredAiVaultOwnership(source.agent, source.providerSessionId)
  if (!owner) {
    return null
  }
  // Existing-owner actions consume identity; provider import metadata is unused.
  return {
    status: 'ready',
    session: {
      agent: source.agent,
      sessionId: source.providerSessionId,
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      executionHostPlatform: process.platform,
      structuredSession: { sessionId: owner.sessionId, workspaceId: owner.workspaceId },
      title: owner.conversationName ?? '',
      filePath: '',
      cwd: null,
      codexHome: null,
      branch: null,
      messageCount: 0,
      previewMessages: []
    }
  }
}
