import { OrcaRuntimeWithStopTerminalsForWorktree } from './worktree-terminal-stop'
import {
  applyWorktreeSleepResumeRecords,
  captureWorktreeSleepResumeRecords,
  type WorktreeSleepResumeRecorder
} from './worktree-sleep-resume-records'

export abstract class OrcaRuntimeWithWorktreeSleepResumeRecording extends OrcaRuntimeWithStopTerminalsForWorktree {
  protected readonly sleepResumeRecords: WorktreeSleepResumeRecorder = {
    capture: (worktreeId, ptyIds) =>
      captureWorktreeSleepResumeRecords({
        worktreeId,
        paneKeysByPtyId: new Map(
          [...ptyIds].map((ptyId) => [ptyId, this.collectAgentStatusPaneKeysForPty(ptyId)])
        ),
        rows: this.getAgentProviderSessionSnapshotFn?.() ?? [],
        checkAgentPresence: this.checkHookAgentPresenceFn,
        capturedAt: Date.now()
      }),
    persist: (worktreeId, capture, stoppedPtyIds) => {
      try {
        const session = this.getWorkspaceSessionForWorktree(worktreeId)
        const next = session && applyWorktreeSleepResumeRecords(session, capture, stoppedPtyIds)
        if (next) {
          this.setWorkspaceSessionForWorktree(worktreeId, next)
        }
      } catch (error) {
        // Why: the PTYs already stopped; a lost record costs the resume, not the sleep.
        console.error('[runtime] could not record slept agent sessions', { worktreeId, error })
      }
    }
  }
}
