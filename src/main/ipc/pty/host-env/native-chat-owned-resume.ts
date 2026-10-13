import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  normalizeAgentProviderSession,
  type AgentProviderSessionMetadata,
  type SleepingAgentLaunchConfig
} from '../../../../shared/agent-session-resume'
import { nativeChatOwnsTerminalResume } from '../../../ai-vault/structured-session-ownership'
import type { AgentSessionRecordStore } from '../../../runtime/agent-session-record-store'

type ResumeSpawnArgs = {
  connectionId?: string | null
  command?: string
  launchAgent?: TuiAgent
  launchConfig?: SleepingAgentLaunchConfig
  launchToken?: unknown
  resumeProviderSession?: AgentProviderSessionMetadata
  env?: Record<string, string>
}

/**
 * Whether a pane's saved resume names a conversation a native chat owns: one that reached the pane
 * through a chat that leaked the pane's identity, or that later moved into a chat. Null when the
 * spawn asks no resume this host's records can own, so it stays synchronous.
 */
export function nativeChatOwnsSpawnResume(
  runtime: { openAgentSessionRecordStore(): Promise<AgentSessionRecordStore> } | undefined,
  args: ResumeSpawnArgs,
  wslDistro: string | null
): Promise<boolean> | null {
  const providerSession = normalizeAgentProviderSession(args.resumeProviderSession)
  const agent = args.launchAgent
  // Why WSL is skipped: native chats run only natively, so a WSL conversation is never a chat's.
  if (!runtime || !providerSession || !agent || args.connectionId || wslDistro !== null) {
    return null
  }
  return Promise.resolve()
    .then(() => runtime.openAgentSessionRecordStore())
    .then((store) => nativeChatOwnsTerminalResume(store.listRecords(), agent, providerSession))
    .catch((error: unknown) => {
      // Why admit: a chat journal that cannot be opened or read must not stop every terminal agent's restore.
      console.warn('[pty] native chat ownership unreadable; resuming the terminal session', error)
      return false
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
