import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  normalizeAgentProviderSession,
  type AgentProviderSessionMetadata,
  type SleepingAgentLaunchConfig
} from '../../../../shared/agent-session-resume'
import { nativeChatOwnsTerminalResume } from '../../../ai-vault/structured-session-ownership'
import type { AgentSessionRecordStore } from '../../../runtime/agent-session-record-store'
import type { RefusedPaneResume } from '../../../../shared/agent-status-types'

type ResumeSpawnArgs = {
  connectionId?: string | null
  command?: string
  launchAgent?: TuiAgent
  launchConfig?: SleepingAgentLaunchConfig
  launchToken?: unknown
  resumeProviderSession?: AgentProviderSessionMetadata
  env?: Record<string, string>
}

/** Who may resume a pane's saved conversation, judged from this host's native chat records. */
export type SpawnResumeOwnership =
  | { verdict: 'owned'; refused: RefusedPaneResume }
  | { verdict: 'unowned' }
  | { verdict: 'unverifiable' }

/**
 * Whether a pane's saved resume names a conversation a native chat owns: one that reached the pane
 * through a chat that leaked the pane's identity, or that later moved into a chat. Null when the
 * spawn asks no resume this host's records can own, so it stays synchronous.
 */
export function nativeChatSpawnResumeOwnership(
  runtime: { openAgentSessionRecordStore(): Promise<AgentSessionRecordStore> } | undefined,
  args: ResumeSpawnArgs,
  wslDistro: string | null
): Promise<SpawnResumeOwnership> | null {
  const providerSession = normalizeAgentProviderSession(args.resumeProviderSession)
  const agent = args.launchAgent
  // Why WSL is skipped: native chats run only natively, so a WSL conversation is never a chat's.
  if (!runtime || !providerSession || !agent || args.connectionId || wslDistro !== null) {
    return null
  }
  return Promise.resolve()
    .then(() => runtime.openAgentSessionRecordStore())
    .then((store): SpawnResumeOwnership =>
      nativeChatOwnsTerminalResume(store.listRecords(), agent, providerSession)
        ? { verdict: 'owned', refused: { agent, providerSession } }
        : { verdict: 'unowned' }
    )
    .catch((error: unknown): SpawnResumeOwnership => {
      console.warn(
        '[pty] native chat records unreadable; cannot tell who owns the saved session',
        error
      )
      return { verdict: 'unverifiable' }
    })
}

/** Turns a refused resume into the pane's plain shell: nothing of the agent launch is left to run,
 *  register, or mark the shell as an unattended agent's. */
export function dropAgentLaunch(args: ResumeSpawnArgs): void {
  const agentEnv = args.launchConfig?.agentEnv ?? {}
  if (args.env) {
    args.env = Object.fromEntries(
      Object.entries(args.env).filter(
        ([key, value]) => key !== 'ORCA_AGENT_LAUNCH_TOKEN' && agentEnv[key] !== value
      )
    )
  }
  delete args.command
  delete args.launchAgent
  delete args.launchConfig
  delete args.launchToken
  delete args.resumeProviderSession
}
