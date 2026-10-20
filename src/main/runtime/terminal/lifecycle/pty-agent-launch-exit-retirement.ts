import { OrcaRuntimeWithSerializeAgentPromptSubmission } from '../input/terminal-agent-status-and-submission'
import type { PtyIncarnationId } from '../../../../shared/pty-incarnation'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import {
  confirmRootShellHasNoChildrenFromProcessTable,
  inspectionShowsShellAlone
} from '../../run-terminal-shell-alone'

export abstract class OrcaRuntimeWithRetirePtyAgentLaunchAuthorityOnConfirmedExit extends OrcaRuntimeWithSerializeAgentPromptSubmission {
  /** Why: an OSC 133 D only says a command finished, and apps such as OMP print their own while
   *  running (#10923); launch identity is retired only once the agent's process is gone. */
  protected retirePtyAgentLaunchAuthorityOnConfirmedExit(ptyId: string): void {
    const pty = this.ptysById.get(ptyId)
    const receipt = this.restoredOrchestrationAuthorityByPtyId.get(ptyId)
    // Why always: the recheck also reconciles an exited hook agent's status row.
    const presence = this.recheckHookAgentPresenceForPty(ptyId)
    if (!pty || (!pty.launchToken && !pty.launchAgent && !receipt)) {
      return
    }
    const { incarnationId, launchToken, launchAgent } = pty
    const generation = this.getPtyLifecycleGeneration(ptyId)
    void this.confirmPtyAgentProcessGone(ptyId, incarnationId, presence).then((gone) => {
      if (
        gone &&
        this.ptysById.get(ptyId) === pty &&
        pty.incarnationId === incarnationId &&
        pty.launchToken === launchToken &&
        pty.launchAgent === launchAgent &&
        this.restoredOrchestrationAuthorityByPtyId.get(ptyId) === receipt &&
        this.getPtyLifecycleGeneration(ptyId) === generation
      ) {
        this.retirePtyAgentLaunchAuthority(ptyId)
      }
    })
  }

  private async confirmPtyAgentProcessGone(
    ptyId: string,
    incarnationId: PtyIncarnationId | null,
    presence: Promise<'live' | 'unverifiable' | 'exited' | null>
  ): Promise<boolean> {
    const verdict = await presence.catch(() => null)
    if (verdict === 'exited') {
      return true
    }
    if (verdict === 'live') {
      return false
    }
    // Why: no checkable hook process (OMP, hooks off, remote row). Shell foreground is not enough:
    // a backgrounded agent still lives, so the host must see nothing else under the shell.
    try {
      if (process.platform === 'win32') {
        return inspectionShowsShellAlone(
          (await this.ptyController?.inspectProcess?.(ptyId, {
            scanChildProcesses: true,
            ...(incarnationId ? { expectedIncarnationId: incarnationId } : {})
          })) ?? null
        )
      }
      const rootPid = (await this.ptyController?.listProcesses?.(LOCAL_EXECUTION_HOST_ID))?.find(
        (pane) => pane.id === ptyId
      )?.rootProcessId
      return rootPid ? await confirmRootShellHasNoChildrenFromProcessTable(rootPid) : false
    } catch {
      return false
    }
  }
}
