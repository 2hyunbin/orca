import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  normalizeAgentProviderSession,
  type AgentProviderSessionMetadata,
  type SleepingAgentLaunchConfig,
  type SleepingAgentSessionRecord
} from '../../../../shared/agent-session-resume'
import type {
  AgentStatusIpcPayload,
  RefusedPaneResume
} from '../../../../shared/agent-status-types'
import type { AgentSessionRecordStore } from '../../../runtime/agent-session-record-store'
import type { ManagedConversationStart } from '../../../runtime/managed-conversation-starts'
import {
  agentSessionLeasePossiblyWriting,
  listStructuredProviderSessionOwnership
} from '../../../native-chat/agent-session-wire/structured-provider-session-ownership'
import { agentHookServer } from '../../../agent-hooks/server'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import {
  keysMayMatch,
  terminalConversationKey,
  type ConversationKey
} from '../../../native-chat/structured-conversation-key'

export type ResumeSpawnArgs = {
  connectionId?: string | null
  command?: string
  launchAgent?: TuiAgent
  launchConfig?: SleepingAgentLaunchConfig
  launchToken?: unknown
  resumeProviderSession?: AgentProviderSessionMetadata
  /** `saved`: the resume was built from a pane's saved facts, not asked for by the user. */
  resumeOrigin?: unknown
  env?: Record<string, string>
}

type AdmissionRuntime = {
  openAgentSessionRecordStore(): Promise<AgentSessionRecordStore>
  reserveManagedConversationStart(keys: readonly ConversationKey[]): ManagedConversationStart
}

/** `chat-home`: an automatic restore of a conversation an open chat continues; `chat-writing`:
 *  any start of one a chat may be writing; `unverifiable`: an automatic restore with no records. */
export type ResumeSpawnRefusal = {
  verdict: 'chat-home' | 'chat-writing' | 'unverifiable'
  refused: RefusedPaneResume
}

export type ResumeSpawnAdmission =
  | { verdict: 'admitted'; start: ManagedConversationStart }
  | ResumeSpawnRefusal

/**
 * Decided on the execution host before any command is issued. An admitted start registers in the
 * same step as the check, so a chat starting meanwhile sees it. Null: nothing here can be a chat's
 * (no resume, a remote or WSL pane), so the spawn stays as it was.
 */
export async function admitResumeSpawn(
  runtime: AdmissionRuntime | undefined,
  args: ResumeSpawnArgs,
  wslDistro: string | null
): Promise<ResumeSpawnAdmission | null> {
  const providerSession = normalizeAgentProviderSession(args.resumeProviderSession)
  const agent = args.launchAgent
  // Native chats run only natively, so a remote or WSL conversation is never a chat's.
  if (!runtime || !providerSession || !agent || args.connectionId || wslDistro !== null) {
    return null
  }
  return judgeResumes(runtime, [{ agent, providerSession }], args.resumeOrigin === 'saved')
}

/** A reattach that found its session gone returns a fresh shell its window then resumes from the
 *  pane's saved facts; this decides that resume before the window can deliver it. */
export async function admitColdRestoreReattach(
  runtime:
    | (AdmissionRuntime & { getAgentProviderSessionRows(): AgentStatusIpcPayload[] })
    | undefined,
  result: { coldRestore?: unknown; isReattach?: boolean },
  pane: { paneKey: string | null; saved: SleepingAgentSessionRecord | undefined },
  wslDistro: string | null
): Promise<ResumeSpawnAdmission | null> {
  const { paneKey, saved } = pane
  if (!runtime || !result.coldRestore || result.isReattach || !paneKey || wslDistro !== null) {
    return null
  }
  const resumes = [
    ...runtime
      .getAgentProviderSessionRows()
      .flatMap((row) =>
        row.paneKey === paneKey && !row.connectionId && row.providerSession
          ? [{ agent: row.agentType, providerSession: row.providerSession }]
          : []
      ),
    ...(saved && !saved.connectionId
      ? [{ agent: saved.agent, providerSession: saved.providerSession }]
      : [])
  ]
  const [first, ...rest] = resumes
  return first ? judgeResumes(runtime, [first, ...rest], true) : null
}

async function judgeResumes(
  runtime: AdmissionRuntime,
  resumes: readonly [RefusedPaneResume, ...RefusedPaneResume[]],
  saved: boolean
): Promise<ResumeSpawnAdmission> {
  const keysOf = ({ agent, providerSession }: RefusedPaneResume) =>
    [providerSession.id, providerSession.transcriptPath].flatMap((id) =>
      id?.trim() ? [terminalConversationKey(agent, id)] : []
    )
  const admitted = (): ResumeSpawnAdmission => ({
    verdict: 'admitted',
    start: runtime.reserveManagedConversationStart(resumes.flatMap(keysOf))
  })
  let store: AgentSessionRecordStore
  try {
    store = await runtime.openAgentSessionRecordStore()
  } catch (error) {
    console.warn(
      "[pty] native chat records unreadable; cannot tell whether a resume is a chat's",
      error
    )
    // Bookkeeping never gates a resume the user asked for.
    return saved ? { verdict: 'unverifiable', refused: resumes[0] } : admitted()
  }
  const heads = listStructuredProviderSessionOwnership(store.listRecords()).filter(
    (holding) => holding.role === 'head'
  )
  const tabs = saved ? store.getVisibleSessionTabIndex() : null
  for (const refused of resumes) {
    const holders = heads.filter((holding) =>
      keysOf(refused).some((key) => keysMayMatch(holding.key, key))
    )
    if (holders.some((holding) => agentSessionLeasePossiblyWriting(holding.lease))) {
      return { verdict: 'chat-writing', refused }
    }
    if (tabs && holders.length > 0 && !tabs.present) {
      return { verdict: 'unverifiable', refused }
    }
    if (tabs && holders.some((holding) => tabs.sessionIds.includes(holding.sessionId))) {
      return { verdict: 'chat-home', refused }
    }
  }
  return admitted()
}

/** A refused resume becomes the pane's plain shell: nothing of the agent launch is left to run,
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

/** The admission at a spawn step: a refused resume leaves the spawn its plain shell. */
export async function applyResumeSpawnAdmission(
  runtime: AdmissionRuntime | undefined,
  args: ResumeSpawnArgs,
  wslDistro: string | null
): Promise<ResumeSpawnAdmission | null> {
  const admission = await admitResumeSpawn(runtime, args, wslDistro)
  if (admission && admission.verdict !== 'admitted') {
    dropAgentLaunch(args)
  }
  return admission
}

export function resumeSpawnRefusal(
  admission: ResumeSpawnAdmission | null
): ResumeSpawnRefusal | null {
  return admission && admission.verdict !== 'admitted' ? admission : null
}

/** An admitted start holds the PTY that runs it; a reattach never ran the launch. */
export function bindResumeSpawnStart(
  runtime:
    | { bindManagedConversationStart(start: ManagedConversationStart, ptyId: string | null): void }
    | undefined,
  admission: ResumeSpawnAdmission | null,
  result: { id: string; isReattach?: boolean }
): void {
  if (admission?.verdict === 'admitted') {
    runtime?.bindManagedConversationStart(admission.start, result.isReattach ? null : result.id)
  }
}

export function dropResumeSpawnStart(admission: ResumeSpawnAdmission | null): void {
  if (admission?.verdict === 'admitted') {
    admission.start.drop()
  }
}

/** Retires a refused resume's claim at once, so the cleanup never waits on this spawn finishing or
 *  a pane receiving its result. An unverifiable refusal keeps everything for the next try. */
export function forgetRefusedResume(
  paneKey: string | null,
  refusal: ResumeSpawnRefusal | null
): void {
  if (!paneKey || !refusal || refusal.verdict === 'unverifiable') {
    return
  }
  try {
    agentHookServer.forgetRefusedPaneResume(paneKey, refusal.refused)
  } catch (error) {
    // The shell still starts, and the next restore refuses and retries the cleanup.
    console.warn('[pty] could not forget a resume a native chat holds', error)
  }
}

/** The pane's saved resume on this host, which its window resumes from after a cold restore. */
export function savedResumeRecord(
  store:
    | { getWorkspaceSession?(hostId: ExecutionHostId): WorkspaceSessionState | undefined }
    | undefined,
  paneKey: string | null
): SleepingAgentSessionRecord | undefined {
  return paneKey
    ? store?.getWorkspaceSession?.(LOCAL_EXECUTION_HOST_ID)?.sleepingAgentSessionsByPaneKey?.[
        paneKey
      ]
    : undefined
}
