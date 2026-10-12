import { TerminalWaitVisibleProbe } from './terminal/wait/terminal-wait-visible-probe'
import { OrcaRuntimeWithCreateAgentPromptRenderGate } from './orca-runtime-create-agent-prompt-render-gate'
import { createSetupCompletionScanner } from './orchestration/setup-completion-signal'
import type { TuiAgent } from '../../shared/tui-agent'
import { isTuiAgent } from '../../shared/tui-agent-config'

export abstract class OrcaRuntimeWithStartTuiIdleVisibleReadProbe extends OrcaRuntimeWithCreateAgentPromptRenderGate {
  /** The agent Orca believes owns this pane, for tui-idle evidence ranking. Launch
   *  authority first; the live foreground agent covers panes Orca did not launch. */
  protected getPaneAgentForTuiIdle(ptyId: string | null | undefined): TuiAgent | null {
    if (!ptyId) {
      return null
    }
    const pty = this.ptysById.get(ptyId)
    const agent = pty?.launchAgent ?? pty?.foregroundAgent ?? null
    return isTuiAgent(agent) ? agent : null
  }

  private readonly waitVisibleProbe = new TerminalWaitVisibleProbe(
    {
      readTerminal: (handle, opts, snapshot) => this.readTerminal(handle, opts, snapshot),
      getLivePtyForHandle: (handle) => this.getLivePtyForHandle(handle),
      getLiveLeafForHandle: (handle) => this.getLiveLeafForHandle(handle)
    },
    this.terminalWaiters
  )

  protected startTuiIdleVisibleReadProbe(
    ...args: Parameters<TerminalWaitVisibleProbe['startTuiIdleVisibleReadProbe']>
  ) {
    return this.waitVisibleProbe.startTuiIdleVisibleReadProbe(...args)
  }

  protected buildTuiIdleProbeResult(
    ...args: Parameters<TerminalWaitVisibleProbe['buildTuiIdleProbeResult']>
  ) {
    return this.waitVisibleProbe.buildTuiIdleProbeResult(...args)
  }

  async waitForSetupTerminalCompletion(
    handle: string,
    signal?: AbortSignal
  ): Promise<{ exitCode: number | null }> {
    const ptyId = this.getLivePtyForHandle(handle)?.pty.ptyId
    if (!ptyId) {
      throw new Error('terminal_handle_stale')
    }
    const completionToken = this.setupCompletionTokenByPtyId.get(ptyId)
    const exitAbort = new AbortController()
    return await new Promise<{ exitCode: number | null }>((resolve, reject) => {
      let settled = false
      let unsubscribe: (() => void) | null = null
      const onAbort = (): void => {
        fail(signal?.reason ?? new Error('request_aborted'))
      }
      const cleanup = (): void => {
        unsubscribe?.()
        exitAbort.abort()
        signal?.removeEventListener('abort', onAbort)
      }
      const finish = (exitCode: number | null): void => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        this.setupCompletionTokenByPtyId.delete(ptyId)
        resolve({ exitCode })
      }
      const fail = (error: unknown): void => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        reject(error)
      }
      if (signal?.aborted) {
        onAbort()
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      const scanner = completionToken ? createSetupCompletionScanner(completionToken, finish) : null

      if (scanner) {
        unsubscribe = this.subscribeToTerminalData(ptyId, scanner.scan)
      }
      // Why: setup can finish before the observer is registered on fast local worktrees.
      const replay = this.recentPtyOutputById.get(ptyId)?.read()
      if (scanner && replay) {
        scanner.scan(replay)
      }
      if (!settled) {
        void this.waitForTerminal(handle, {
          condition: 'exit',
          signal: exitAbort.signal
        })
          .then((wait) => {
            if (wait.satisfied && wait.condition === 'exit' && wait.status === 'exited') {
              finish(wait.exitCode)
            }
          })
          .catch(fail)
      }
    })
  }
}
