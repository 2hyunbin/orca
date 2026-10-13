import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  normalizeAgentProviderSession,
  type AgentProviderSessionMetadata
} from '../../../../shared/agent-session-resume'
import { nativeChatOwnsTerminalResume } from '../../../ai-vault/structured-session-ownership'
import type { AgentSessionRecordStore } from '../../../runtime/agent-session-record-store'
import type { CodexResumeLaunch } from './codex-resume'

type ResumeSpawnArgs = {
  connectionId?: string | null
  launchAgent?: TuiAgent
  resumeProviderSession?: AgentProviderSessionMetadata
}

/**
 * A pane's saved resume names a conversation a native chat owns: it reached the pane through a
 * chat that leaked the pane's identity, or the conversation moved into a chat. Resuming it would
 * be a second writer on the chat's transcript in the wrong mode, so the pane starts its plain shell
 * and says the old session is unavailable. Null when the resume may run, or when no resume is asked;
 * only a local resume reads this host's records.
 */
export function nativeChatOwnedResumeLaunch(
  runtime: { openAgentSessionRecordStore(): Promise<AgentSessionRecordStore> } | undefined,
  args: ResumeSpawnArgs
): Promise<CodexResumeLaunch | null> | null {
  const providerSession = normalizeAgentProviderSession(args.resumeProviderSession)
  const agent = args.launchAgent
  // Why not async: a spawn that asks no resume must not gain a tick, which reorders pane-spawn races.
  if (!runtime || !providerSession || !agent || args.connectionId) {
    return null
  }
  return Promise.resolve()
    .then(() => runtime.openAgentSessionRecordStore())
    .then((store): CodexResumeLaunch | null =>
      nativeChatOwnsTerminalResume(store.listRecords(), agent, providerSession)
        ? {
            codexResumeHome: null,
            command: undefined,
            notifyResumeUnavailable: true,
            droppedResumeArgv: false,
            providerSession
          }
        : null
    )
    .catch((error: unknown) => {
      // Why admit: a chat journal that cannot be opened or read must not stop every terminal agent's restore.
      console.warn('[pty] native chat ownership unreadable; resuming the terminal session', error)
      return null
    })
}
