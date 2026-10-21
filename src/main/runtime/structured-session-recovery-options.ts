import { createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { agentSessionProviderHandleChainHead } from '../../shared/agent-session-provider-handle'
import { getClaudeProfileRouter } from '../claude-accounts/claude-profile-installed-router'
import { structuredAgentRuntimeMetadata } from './structured-agent-runtime-metadata'
import { nativeChatScratchFolderFor } from '../native-chat/native-chat-scratch-folder'
import type {
  StructuredAgentTranscriptImport,
  StructuredAgentTranscriptSource
} from '../native-chat/structured-agent-cli-conversations'

export type RecoveryContextCache = {
  key?: string
  source?: StructuredAgentTranscriptSource
  ready?: { version: string; path: string }
  pending?: Promise<string | null>
}

/** One successful source and one flight per conversation; neither retains decoded history. */
async function readableContext(
  cache: RecoveryContextCache,
  key: string,
  source: Omit<StructuredAgentTranscriptSource, 'transcriptPath'>,
  importer: StructuredAgentTranscriptImport,
  stateDirectory: string,
  sessionId: string,
  locate: () => Promise<string | null>
): Promise<string | null> {
  if (cache.key === key && cache.pending) {
    return cache.pending
  }
  const current: RecoveryContextCache = cache.key === key ? { ...cache } : { key }
  const run = async () => {
    let path = current.source?.transcriptPath
    if (path) {
      path =
        (await importer.admitTranscriptPath({ store: source.store, transcriptPath: path })) ??
        undefined
    }
    if (!path || !(await stat(path).catch(() => null))?.isFile()) {
      path = (await locate()) ?? undefined
    }
    if (!path || !isAbsolute(path)) {
      return null
    }
    const located = { ...source, transcriptPath: path }
    current.source = located
    const context = importer.readableContext
    if (context.kind === 'file') {
      return path
    }
    const version = await context.version(located)
    if (!version) {
      return null
    }
    if (
      current.ready?.version === version &&
      (await stat(current.ready.path).catch(() => null))?.isFile()
    ) {
      return current.ready.path
    }
    // Source identity, not click/cut identity: delayed drafts keep the same conversation forever.
    const identity = createHash('sha256').update(JSON.stringify(source)).digest('hex')
    const output = join(
      nativeChatScratchFolderFor(stateDirectory, sessionId),
      `handoff-${identity}.json`
    )
    const prepared = await context.prepare(located, output)
    if (prepared) {
      current.ready = { version, path: prepared }
    }
    return prepared
  }
  const pending = run().catch((error: unknown) => {
    console.warn('Could not prepare saved chat context', error)
    return null
  })
  Object.assign(cache, current, { key, pending })
  // A changed key owns a different object; late work cannot replace its newer result.
  current.pending = pending
  try {
    const path = await pending
    if (cache.pending === pending) {
      cache.source = current.source
      cache.ready = path ? current.ready : undefined
      if (!path) {
        cache.source = undefined
      }
    }
    return path
  } finally {
    if (cache.pending === pending) {
      cache.pending = undefined
    }
  }
}

/** Facts are rederived at action time; only the identified readable content is reusable. */
export async function structuredSessionRecoveryOptions(
  record: AgentSessionRecord | null,
  launchEnv: NodeJS.ProcessEnv,
  input: { cache: RecoveryContextCache; cutKey: string; stateDirectory: string }
): Promise<{ canSwitchAccount: boolean; transcriptPath?: string }> {
  const metadata = record && structuredAgentRuntimeMetadata(record.provider)
  const head = record && agentSessionProviderHandleChainHead(record.providerHandleChain)
  const importer = metadata?.transcriptImport
  if (!record || !metadata || !head || !importer) {
    return { canSwitchAccount: false }
  }
  try {
    const store = importer.conversationStore({ accountHome: record.accountHome, launchEnv })
    if (!store) {
      return { canSwitchAccount: false }
    }
    const source = {
      provider: record.provider,
      handle: head,
      accountHome: record.accountHome,
      store,
      providerSessionId: metadata.sessionHistory.rowSessionId(head),
      workspaceCwd: record.launchDirectory ?? ''
    }
    const key = JSON.stringify([
      input.cutKey,
      record.providerHandleChain,
      record.accountHome,
      source
    ])
    const transcriptPath = await readableContext(
      input.cache,
      key,
      source,
      importer,
      input.stateDirectory,
      record.sessionId,
      () =>
        importer.handleNamesTranscript
          ? importer.admitTranscriptPath({ store, transcriptPath: head.handle.nativeId })
          : importer.findTranscript({ ...source, launchEnv })
    )
    if (!transcriptPath) {
      return { canSwitchAccount: false }
    }
    const router = getClaudeProfileRouter()
    let canSwitchAccount = false
    if (
      router &&
      record.provider === 'claude' &&
      record.location.wslDistro === null &&
      metadata.launchFollowsSelection?.()
    ) {
      try {
        const roots = await Promise.all(
          [
            store,
            ...(await router.accountSelectionHomes(launchEnv)).map((home) => join(home, 'projects'))
          ].map((root) => realpath(root))
        )
        canSwitchAccount = roots.every((root) => root === roots[0])
      } catch {
        canSwitchAccount = false
      }
    }
    return { canSwitchAccount, transcriptPath }
  } catch (error) {
    console.warn('Could not read chat recovery options', error)
    return { canSwitchAccount: false }
  }
}
