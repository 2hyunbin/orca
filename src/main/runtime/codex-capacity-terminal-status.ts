import {
  CodexCapacityNoticeTracker,
  CODEX_CAPACITY_MESSAGE
} from '../../shared/codex-capacity-notice'
import type {
  AgentStatusIpcPayload,
  ParsedAgentStatusPayload
} from '../../shared/agent-status-types'
import { recognizeAgentProcessFromCommandLine } from '../../shared/agent-process-recognition'
import type { HeadlessEmulator } from '../daemon/headless-emulator'

const trackers = new WeakMap<HeadlessEmulator, CodexCapacityNoticeTracker>()
type CodexCapacityStatus = Pick<
  AgentStatusIpcPayload,
  'agentType' | 'prompt' | 'model' | 'subagents' | 'mainAgent' | 'turnStartedAt'
>

export function observeCodexCapacityTerminalStatus(
  emulator: HeadlessEmulator,
  data: string,
  startupCommand: string | undefined,
  launchAgent: string | null | undefined,
  readStatus: () => CodexCapacityStatus | undefined,
  outputObservedAt = Date.now()
): ParsedAgentStatusPayload | null {
  let tracker = trackers.get(emulator)
  if (
    !tracker &&
    launchAgent !== 'codex' &&
    recognizeAgentProcessFromCommandLine(startupCommand)?.agent !== 'codex'
  ) {
    // A Codex started from an existing shell is identified by its host-owned hook row.
    if ((!data.includes('■') && !data.includes('⚠')) || readStatus()?.agentType !== 'codex') {
      return null
    }
  }
  if (!tracker) {
    tracker = new CodexCapacityNoticeTracker()
    trackers.set(emulator, tracker)
  }
  if (!tracker.observe(data, () => emulator.getVisibleLines())) {
    return null
  }
  const previous = readStatus()
  if (previous && previous.agentType !== 'codex') {
    return null
  }
  // Queued emulator writes must not close a newer turn opened by a live hook.
  if (previous?.turnStartedAt !== undefined && previous.turnStartedAt > outputObservedAt) {
    return null
  }
  if (previous?.mainAgent?.outcome === 'failure') {
    return null
  }
  return {
    state: 'done',
    agentType: 'codex',
    prompt: previous?.prompt ?? '',
    model: previous?.model,
    subagents: previous?.subagents,
    lastAssistantMessage: CODEX_CAPACITY_MESSAGE,
    lastAssistantMessageIsToolOutput: true,
    mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: Date.now() }
  }
}
