import { OrcaRuntimeWithPruneMobileSessionTabGroupLayout } from '../../orca-runtime-prune-mobile-session-tab-group-layout'
import type { OrcaRuntimeWithGetPtyRecordForPaneKey } from '../../orca-runtime-get-pty-record-for-pane-key'
import { recognizeAgentProcess } from '../../../../shared/agent-process-recognition'
import {
  resolveStructuredWorkerAuthority,
  resolveStructuredWorkerIdentityForSession
} from '../../structured-worker-authority'

export abstract class RuntimeTerminalPromptAgentPresence extends OrcaRuntimeWithPruneMobileSessionTabGroupLayout {
  protected abstract isTerminalRunningAgent(
    ...args: Parameters<OrcaRuntimeWithGetPtyRecordForPaneKey['isTerminalRunningAgent']>
  ): ReturnType<OrcaRuntimeWithGetPtyRecordForPaneKey['isTerminalRunningAgent']>

  async isTerminalRunningSettledPromptAgent(handle: string): Promise<boolean> {
    try {
      const livePty = this.getLivePtyForHandle(handle)
      const leaf = livePty ? null : this.getLiveLeafForHandle(handle).leaf
      const ptyId = livePty?.pty.ptyId ?? leaf?.ptyId ?? null
      const trackedPty = livePty?.pty ?? (ptyId ? this.ptysById.get(ptyId) : null)
      if (!ptyId || !trackedPty || !this.ptyController) {
        return false
      }
      let foregroundProcess = await this.ptyController.getForegroundProcess(ptyId)
      let agent = recognizeAgentProcess(foregroundProcess)?.agent
      // Why: the cached foreground name can be an executable basename nothing recognizes
      // (macOS p_comm reports the native Claude installer as `2.1.258`), and treating that
      // as "no agent" silently downgrades the prompt to unframed chunks, which Claude's
      // composer truncates. A fresh process-table scan reads the real command line.
      if (agent === undefined && this.ptyController.confirmForegroundProcess) {
        foregroundProcess = await this.ptyController.confirmForegroundProcess(ptyId)
        agent = recognizeAgentProcess(foregroundProcess)?.agent
      }
      if (agent !== 'claude' && agent !== 'codex') {
        return false
      }
      if (
        !(await this.isTerminalRunningAgent(handle, {
          retryForegroundWrappers: false,
          foregroundProcess
        }))
      ) {
        return false
      }
      trackedPty.foregroundAgent = agent
      return true
    } catch {
      return false
    }
  }

  /**
   * A structured worker's own pane key, for callers that can only name the session.
   *
   * Resolved HERE rather than published: the pane key is a random identity credential — anyone
   * holding it can read and consume that worker's mailbox, and session ids are embedded in tab ids
   * — so it must never travel to a renderer to be echoed back.
   */
  getStructuredWorkerPaneKeyForSession(sessionId: string): string | null {
    const identity = resolveStructuredWorkerIdentityForSession(sessionId, this._orchestrationDb)
    return identity && resolveStructuredWorkerAuthority(identity.handle, this._orchestrationDb)
      ? identity.paneKey
      : null
  }
}
