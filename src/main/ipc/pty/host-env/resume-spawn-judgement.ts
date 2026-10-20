import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig,
  SleepingAgentSessionRecord
} from '../../../../shared/agent-session-resume'
import { normalizeAgentProviderSession } from '../../../../shared/agent-session-resume'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type {
  AgentStatusIpcPayload,
  RefusedPaneResume
} from '../../../../shared/agent-status-types'
import type { AgentSessionRecordStore } from '../../../runtime/agent-session-record-store'
import type { SwitchClaim } from '../../../runtime/session-tabs/structured-session-switch-claims'
import { TERMINAL_SWITCH_GENERATION_ENV } from '../../../../shared/terminal-switch'
import {
  agentSessionLeasePossiblyWriting,
  listStructuredProviderSessionOwnership
} from '../../../native-chat/agent-session-wire/structured-provider-session-ownership'
import {
  keysMayMatch,
  terminalConversationKey
} from '../../../native-chat/structured-conversation-key'

export type ResumeSpawnArgs = {
  connectionId?: string | null
  command?: string
  launchAgent?: TuiAgent
  launchConfig?: SleepingAgentLaunchConfig
  launchToken?: unknown
  resumeProviderSession?: AgentProviderSessionMetadata
  /** `saved`: built from a pane's saved facts; `switch`: the terminal half of a chat's switch. */
  resumeOrigin?: unknown
  env?: Record<string, string>
}

export type AdmissionRuntime = {
  getAgentProviderSessionRows?(): AgentStatusIpcPayload[]
  readSavedResumeSource?(
    worktreeId: string,
    paneKey: string
  ): Promise<SleepingAgentSessionRecord | undefined>
  openAgentSessionRecordStore(): Promise<AgentSessionRecordStore>
  acceptSwitchStart?(generation: string, paneKey: string): SwitchClaim | null
  saveSwitchClaim?(claim: SwitchClaim): Promise<boolean>
  dispatchSwitchStart?(claim: SwitchClaim): { switchGeneration: string; switchOwner: string }
}

/** The spawn options a switch admission reads its generation from and hands its owner fields to. */
export type SwitchSpawnOptions = {
  env?: Record<string, string>
  switchGeneration?: string
  switchOwner?: string
}

/** `chat-home`: an automatic restore of a conversation an open chat continues; `chat-writing`:
 *  any start of one a chat may be writing; `unverifiable`: an automatic restore with no records. */
export type ResumeSpawnRefusal = {
  sourceRecord?: SleepingAgentSessionRecord
  verdict: 'chat-home' | 'chat-writing' | 'unverifiable'
  refused: RefusedPaneResume
}

export type ResumeSpawnAdmission =
  | {
      verdict: 'admitted'
      refused: RefusedPaneResume
      sourceRecord?: SleepingAgentSessionRecord
    }
  | ResumeSpawnRefusal

export async function judgeResumes(
  runtime: AdmissionRuntime,
  resumes: readonly [RefusedPaneResume, ...RefusedPaneResume[]],
  /** A switch's own start: its chat tab is still open on purpose, so only a writing chat refuses. */
  switchStart = false
): Promise<ResumeSpawnAdmission> {
  const keysOf = ({ agent, providerSession }: RefusedPaneResume) =>
    [providerSession.id, providerSession.transcriptPath].flatMap((id) =>
      id?.trim() ? [terminalConversationKey(agent, id)] : []
    )
  const admitted = (): ResumeSpawnAdmission => ({
    verdict: 'admitted',
    refused: resumes[0]
  })
  let store: AgentSessionRecordStore
  try {
    store = await runtime.openAgentSessionRecordStore()
  } catch (error) {
    console.warn(
      "[pty] native chat records unreadable; cannot tell whether a resume is a chat's",
      error
    )
    return { verdict: 'unverifiable', refused: resumes[0] }
  }
  const heads = listStructuredProviderSessionOwnership(store.listRecords()).filter(
    (holding) => holding.role === 'head'
  )
  const tabs = store.getVisibleSessionTabIndex()
  for (const refused of resumes) {
    const holders = heads.filter((holding) =>
      keysOf(refused).some((key) => keysMayMatch(holding.key, key))
    )
    if (holders.some((holding) => agentSessionLeasePossiblyWriting(holding.lease))) {
      return { verdict: 'chat-writing', refused }
    }
    if (switchStart) {
      continue
    }
    if (holders.length > 0 && (!tabs || !tabs.present)) {
      return { verdict: 'unverifiable', refused }
    }
    if (tabs && holders.some((holding) => tabs.sessionIds.includes(holding.sessionId))) {
      return { verdict: 'chat-home', refused }
    }
  }
  return admitted()
}

/** The terminal half of a chat's switch. Its generation takes this pane and is saved on the chat
 *  before the owner gets it; a refusal sends nothing, and only the owner then says it never started. */
export async function admitSwitchResumeSpawn(
  runtime: AdmissionRuntime | undefined,
  args: ResumeSpawnArgs,
  wslDistro: string | null,
  spawn?: { paneKey: string | null; options: SwitchSpawnOptions }
): Promise<ResumeSpawnAdmission> {
  const generation = args.env?.[TERMINAL_SWITCH_GENERATION_ENV]
  delete args.env?.[TERMINAL_SWITCH_GENERATION_ENV]
  delete spawn?.options.env?.[TERMINAL_SWITCH_GENERATION_ENV]
  const providerSession = normalizeAgentProviderSession(args.resumeProviderSession)
  const agent = args.launchAgent
  if (!providerSession || !agent) {
    throw new Error('switch_start_missing_conversation')
  }
  const refused = { agent, providerSession }
  if (args.connectionId || wslDistro !== null || !generation || !spawn?.paneKey) {
    return { verdict: 'unverifiable', refused }
  }
  // Before any await: a chat start whose census ends after this point sees the claim.
  const claim = runtime?.acceptSwitchStart?.(generation, spawn.paneKey)
  if (!claim || claim.providerSessionId !== providerSession.id) {
    return { verdict: 'chat-writing', refused }
  }
  if (!(await runtime?.saveSwitchClaim?.(claim))) {
    return { verdict: 'unverifiable', refused }
  }
  const admission = await judgeResumes(runtime, [refused], true)
  if (admission.verdict === 'admitted' && runtime?.dispatchSwitchStart) {
    Object.assign(spawn.options, runtime.dispatchSwitchStart(claim))
  }
  return admission
}
