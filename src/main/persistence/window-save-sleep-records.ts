// A window save in a build where the window still writes the session's resume records: main alone
// writes and resumes a workspace sleep's records, so the save keeps main's and drops the window's.

import type { SleepingAgentSessionRecord } from '../../shared/agent-session-resume'
import { isWorkspaceSleepRecord } from '../../shared/workspace-sleep'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../shared/workspace-session-state-types'

type Records = Record<string, SleepingAgentSessionRecord>

function withMainSleepRecords(stored: Records | undefined, saved: Records): Records {
  const kept = Object.entries(saved).filter(([, record]) => !isWorkspaceSleepRecord(record))
  const main = Object.entries(stored ?? {}).filter(([, record]) => isWorkspaceSleepRecord(record))
  return Object.fromEntries([...kept, ...main])
}

export function windowSaveKeepingMainSleepRecords<
  T extends WorkspaceSessionState | WorkspaceSessionPatch
>(stored: WorkspaceSessionState, save: T): T {
  const saved = save.sleepingAgentSessionsByPaneKey
  return saved
    ? {
        ...save,
        sleepingAgentSessionsByPaneKey: withMainSleepRecords(
          stored.sleepingAgentSessionsByPaneKey,
          saved
        )
      }
    : save
}
