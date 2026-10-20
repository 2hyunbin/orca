import { realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { agentSessionProviderHandleChainHead } from '../../shared/agent-session-provider-handle'
import { getClaudeProfileRouter } from '../claude-accounts/claude-profile-installed-router'
import { structuredAgentRuntimeMetadata } from './structured-agent-runtime-metadata'

/** The same account-scoped importer used to open a chat's real conversation in the CLI. */
export async function structuredSessionRecoveryOptions(
  record: AgentSessionRecord | null,
  launchEnv: NodeJS.ProcessEnv = process.env
): Promise<{ canSwitchAccount: boolean; transcriptPath?: string }> {
  const metadata = record && structuredAgentRuntimeMetadata(record.provider)
  const head = record && agentSessionProviderHandleChainHead(record.providerHandleChain)
  const importer = metadata?.transcriptImport
  if (!record || !metadata || !head || !importer) {
    return { canSwitchAccount: false }
  }
  try {
    const store = importer.conversationStore({ accountHome: record.accountHome, launchEnv })
    const transcriptPath = importer.handleNamesTranscript
      ? store
        ? await importer.admitTranscriptPath({ store, transcriptPath: head.handle.nativeId })
        : null
      : store
        ? await importer.findTranscript({
            providerSessionId: metadata.sessionHistory.rowSessionId(head),
            store,
            launchEnv,
            workspaceCwd: record.launchDirectory ?? ''
          })
        : null
    if (!transcriptPath || !isAbsolute(transcriptPath)) {
      return { canSwitchAccount: false }
    }
    const router = getClaudeProfileRouter()
    let canSwitchAccount = false
    if (
      store &&
      router &&
      record.provider === 'claude' &&
      record.location.wslDistro === null &&
      metadata.launchFollowsSelection?.()
    ) {
      try {
        // Profile setup shares projects by symlink/junction; prove every switch destination shares it.
        const roots = await Promise.all(
          [
            store,
            ...(await router.accountSelectionHomes()).map((home) => join(home, 'projects'))
          ].map((root) => realpath(root))
        )
        canSwitchAccount = roots.every((root) => root === roots[0])
      } catch {
        canSwitchAccount = false
      }
    }
    return { canSwitchAccount, transcriptPath }
  } catch {
    return { canSwitchAccount: false }
  }
}
