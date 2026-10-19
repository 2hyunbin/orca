import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { agentSessionLeaseAdmitsWriter } from '../../shared/agent-session-lease-adjudication'
import { defaultAgentChatLabel } from '../../shared/agent-session-chat-label'
import type { AiVaultListResult } from '../../shared/ai-vault-types'
import { historyRowShowsChatName } from '../../shared/structured-chat-row-name'
import type { AiVaultSearchResponse } from '../../shared/ai-vault-search-types'
import type { AiVaultPrepareSessionResumeArgs } from '../../shared/ai-vault-resume-preparation'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { ensureStructuredAgentSessionHostUnlessRefused } from '../runtime/structured-agent-session-host-refusal'
import {
  listStructuredProviderSessionOwnership,
  terminalResumeBlocked,
  type StructuredProviderSessionOwnership
} from '../native-chat/agent-session-wire/structured-provider-session-ownership'
import type { StructuredAgentId } from '../../shared/agent-session-provider-handle'
import {
  sessionHistoryBinaryNames,
  type StructuredAgentResumeInvocation,
  type StructuredAgentSessionHistory
} from '../native-chat/structured-agent-cli-conversations'
import { STRUCTURED_AGENT_RUNTIME_METADATA } from '../runtime/structured-agent-runtime-metadata'
import type { StructuredAgentRuntimeMetadata } from '../runtime/structured-agent-runtime-registration-types'
import { commandName, commandProgramIndex, shellCommands } from './shell-command-words'

/** Whether the client a projection answers opens a chat of this agent from its history row. A row
 *  owned by a chat it cannot open is hidden from it: resuming that row in a terminal is refused. */
export type StructuredChatOpener = (agent: StructuredAgentId) => boolean

export const OPENS_EVERY_STRUCTURED_CHAT: StructuredChatOpener = () => true

export function projectStructuredAiVaultSessions(
  result: AiVaultListResult,
  opensChat: StructuredChatOpener
): AiVaultListResult {
  const owner = ownershipLookup()
  if (!owner) {
    return result
  }
  const sessions = result.sessions.flatMap((session) => {
    const ownership = session.executionHostId === LOCAL_EXECUTION_HOST_ID ? owner(session) : null
    if (!ownership) {
      return [session]
    }
    if (!opensChat(ownership.provider)) {
      return []
    }
    return [{ ...session, ...ownedRow(session.agent, ownership) }]
  })
  return sessions.length === result.sessions.length &&
    sessions.every((row, index) => row === result.sessions[index])
    ? result
    : { ...result, sessions }
}

/** Indexed hits name and own a native chat exactly as list rows do; only this host's index can.
 *  An owned hit opens its chat, so it carries no terminal resume command. */
export function projectStructuredAiVaultSearchResponse(
  response: AiVaultSearchResponse,
  opensChat: StructuredChatOpener
): AiVaultSearchResponse {
  const owner = response.kind === 'results' ? ownershipLookup() : null
  if (!owner || response.kind !== 'results') {
    return response
  }
  return {
    ...response,
    hits: response.hits.flatMap((hit) => {
      const ownership = owner(hit)
      if (!ownership) {
        return [hit]
      }
      if (!opensChat(ownership.provider)) {
        return []
      }
      const { resumeCommand: _resumeCommand, ...owned } = hit
      return [{ ...owned, ...ownedRow(hit.agent, ownership) }]
    })
  }
}

/** The hits once the chat host is installed; plain hits if it will not install, since owning and
 *  naming them must never cost the user the search. */
export async function searchWithStructuredOwners(
  search: Promise<AiVaultSearchResponse>,
  options: {
    ensureHost?: (() => Promise<unknown>) | undefined
    opensChat: StructuredChatOpener
  }
): Promise<AiVaultSearchResponse> {
  const { ensureHost } = options
  const hostReady = ensureHost
    ? ensureStructuredAgentSessionHostUnlessRefused(ensureHost).then(
        () => true,
        (error: unknown) => {
          console.warn('[ai-vault-search] returning hits without native chat owners', error)
          return false
        }
      )
    : true
  const response = await search
  return (await hostReady)
    ? projectStructuredAiVaultSearchResponse(response, options.opensChat)
    : response
}

function ownedRow(rowAgent: string, ownership: StructuredProviderSessionOwnership) {
  const structuredSession = {
    sessionId: ownership.sessionId,
    workspaceId: ownership.workspaceId
  }
  return historyRowShowsChatName(rowAgent)
    ? {
        title: ownership.conversationName ?? defaultAgentChatLabel(ownership.provider),
        structuredSession
      }
    : { structuredSession }
}

/** One index per projection: a list holds hundreds of rows, each once searched every record. A row
 *  names the chat continuing its conversation now, else one whose chain held it earlier. */
function ownershipLookup():
  | ((row: { agent: string; sessionId: string }) => StructuredProviderSessionOwnership | null)
  | null {
  if (!getStructuredAgentSessionHost()) {
    return null
  }
  const byProviderSession = new Map<string, StructuredProviderSessionOwnership>()
  for (const ownership of listOwnership()) {
    const key = `${ownership.provider}\0${ownership.providerSessionId}`
    const kept = byProviderSession.get(key)
    if (!kept || (kept.role !== 'head' && ownership.role === 'head')) {
      byProviderSession.set(key, ownership)
    }
  }
  return (row) => {
    const found = historyRowOwners(row.agent).flatMap(
      (owner) => byProviderSession.get(`${owner}\0${row.sessionId}`) ?? []
    )
    return found.find((ownership) => ownership.role === 'head') ?? found[0] ?? null
  }
}

/** The agents whose chats own history rows listed under each row agent: one CLI can run as several. */
const HISTORY_ROW_OWNERS = new Map<string, StructuredAgentId[]>()
for (const { definition, sessionHistory } of STRUCTURED_AGENT_RUNTIME_METADATA) {
  for (const rowAgent of sessionHistory.rowAgents) {
    HISTORY_ROW_OWNERS.set(rowAgent, [
      ...(HISTORY_ROW_OWNERS.get(rowAgent) ?? []),
      definition.agent
    ])
  }
}

function historyRowOwners(rowAgent: string): readonly StructuredAgentId[] {
  return HISTORY_ROW_OWNERS.get(rowAgent) ?? []
}

export function assertLegacyAiVaultResumeAllowed(args: AiVaultPrepareSessionResumeArgs): void {
  // A fork writes a new conversation, and preparing its home never writes this one.
  const blocking = args.fork ? undefined : resumeOwnerships(args).find(terminalResumeBlocked)
  if (blocking) {
    refuseLegacyWriter(blocking)
  }
}

/** A terminal resume a command asks for: the chat agent whose conversations it names, and the
 *  conversation (null: any of that agent's). */
export type AdmittedResumeInvocation = { provider: StructuredAgentId; target: string | null }

/** Refuses a command resuming a conversation a chat holds; otherwise `register` runs in the same
 *  synchronous step as the check, so a chat starting meanwhile sees what it registered. */
export async function assertLegacyAiVaultResumeCommandAllowed<T>(
  command: string,
  ensureHost: () => Promise<void>,
  register?: (invocations: AdmittedResumeInvocation[]) => T
): Promise<T | undefined> {
  const invocations = parseResumeInvocations(command)
  if (invocations.length === 0) {
    return undefined
  }
  // A terminal command is not a chat: with chats refused here there is no ownership to check.
  await ensureStructuredAgentSessionHostUnlessRefused(ensureHost)
  for (const ownership of listOwnership()) {
    if (
      terminalResumeBlocked(ownership) &&
      invocations.some((invocation) => resumesOwnedSession(invocation, ownership))
    ) {
      refuseLegacyWriter(ownership)
    }
  }
  return register?.(invocations.map(({ provider, target }) => ({ provider, target })))
}

/** Any chat whose chain ever held the row a resume or fork names; null when none did. */
export function findResumeOwnership(
  args: Pick<AiVaultPrepareSessionResumeArgs, 'agent' | 'sessionId' | 'filePath'>
): StructuredProviderSessionOwnership | null {
  return resumeOwnerships(args)[0] ?? null
}

/** Every link naming the row, those matched by id first. */
function resumeOwnerships(
  args: Pick<AiVaultPrepareSessionResumeArgs, 'agent' | 'sessionId' | 'filePath'>
): StructuredProviderSessionOwnership[] {
  const owners = new Set(historyRowOwners(args.agent))
  if (owners.size === 0) {
    return []
  }
  const owned = listOwnership().filter((ownership) => owners.has(ownership.provider))
  const fileName = args.filePath.split(/[\\/]/).at(-1) ?? ''
  return [
    ...(args.sessionId
      ? owned.filter((ownership) => ownership.providerSessionId === args.sessionId)
      : []),
    ...owned.filter((ownership) => fileName.includes(ownership.providerSessionId))
  ]
}

function listOwnership(): StructuredProviderSessionOwnership[] {
  const host = getStructuredAgentSessionHost()
  return host ? listStructuredProviderSessionOwnership(host.deps.store.listRecords()) : []
}

function resumesOwnedSession(
  invocation: ResumeInvocation,
  ownership: StructuredProviderSessionOwnership
): boolean {
  if (invocation.provider !== ownership.provider) {
    return false
  }
  // A target-less resume (--last, --continue, or a bare --resume/-r) may pick
  // any provider session, so it cannot be admitted while one is structured.
  // Only an explicit target that names a different session is safe.
  if (invocation.target === null) {
    return true
  }
  const matches = invocation.history.resumeTargetMatches ?? sameIdInAnyCase
  return matches(invocation.target, ownership.providerSessionId)
}

function sameIdInAnyCase(target: string, rowSessionId: string): boolean {
  return target.toLowerCase() === rowSessionId.toLowerCase()
}

type ResumeInvocation = StructuredAgentResumeInvocation & {
  provider: StructuredAgentId
  history: StructuredAgentSessionHistory
}

function parseResumeInvocations(command: string): ResumeInvocation[] {
  // One binary can run the chats of several agents; a resume of it is checked against each.
  const binaries = new Map<string, StructuredAgentRuntimeMetadata[]>()
  for (const registration of STRUCTURED_AGENT_RUNTIME_METADATA) {
    for (const name of sessionHistoryBinaryNames(registration.sessionHistory)) {
      binaries.set(name, [...(binaries.get(name) ?? []), registration])
    }
  }
  // Only a command's program can resume: a name elsewhere is an argument or prompt text
  // ("Fix the Pi --resume flag", `claude --model pi -r x`).
  const invocations: ResumeInvocation[] = []
  for (const words of shellCommands(command)) {
    const program = commandProgramIndex(words)
    for (const registration of binaries.get(commandName(words[program] ?? '')) ?? []) {
      const history = registration.sessionHistory
      const invocation = history.parseResumeArgs(words.slice(program + 1))
      if (invocation) {
        invocations.push({
          ...invocation,
          provider: registration.definition.agent,
          history
        })
      }
    }
  }
  return invocations
}

function refuseLegacyWriter(ownership: StructuredProviderSessionOwnership): never {
  throw new Error(
    agentSessionLeaseAdmitsWriter(ownership.lease)
      ? 'agent_session_conflict'
      : 'agent_session_ownership_unknown'
  )
}
