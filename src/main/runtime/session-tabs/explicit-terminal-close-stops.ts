import { EXPLICIT_TERMINAL_CLOSE_STOP_TIMEOUT_MS } from '../orca-runtime-core'
import { SSH_PROVIDER_UNREGISTERED_REASON } from '../../../shared/pty-liveness-verdict'
import type { PtyLivenessVerdict } from '../../../shared/pty-liveness-verdict'
import { errorMessage } from '../../../shared/error-message'
import type { RuntimePtyController } from '../runtime-pty-controller-contract'
import type { RuntimePtyWorktreeRecord } from '../runtime-terminal-state-records'
export type ExplicitCloseStop = { stopped: boolean }
const NO_STOP: ExplicitCloseStop = { stopped: false }

export type RuntimeExplicitTerminalCloseStopsHost = {
  markPtyStopRequested(ptyId: string): void
  getPty(ptyId: string): RuntimePtyWorktreeRecord | undefined
  getPtyController(): Pick<RuntimePtyController, 'stopAndWait' | 'kill'> | null
  markPtyLivenessUnverifiable(ptyId: string, reason: string): void
  getPtyLivenessVerdict(ptyId: string): PtyLivenessVerdict | null
}

export class RuntimeExplicitTerminalCloseStops {
  private get controller(): ReturnType<RuntimeExplicitTerminalCloseStopsHost['getPtyController']> {
    return this.host.getPtyController()
  }

  constructor(private readonly host: RuntimeExplicitTerminalCloseStopsHost) {}

  async stopExplicitlyClosedTabPtys(
    ptyIds: readonly string[],
    addressedPtyId: string
  ): Promise<ExplicitCloseStop> {
    let addressedPtyStop = NO_STOP
    const deadlineMs = Date.now() + EXPLICIT_TERMINAL_CLOSE_STOP_TIMEOUT_MS
    for (const ptyId of ptyIds) {
      this.host.markPtyStopRequested(ptyId)
      const expectedIncarnationId = this.host.getPty(ptyId)?.incarnationId
      let stopped = false
      if (this.controller?.stopAndWait) {
        try {
          stopped = await this.controller.stopAndWait(ptyId, { deadlineMs })
        } catch (error) {
          this.host.markPtyLivenessUnverifiable(ptyId, errorMessage(error))
        }
        // Preserve an observed exit when a broader inventory check could not finish.
        if (
          !stopped &&
          expectedIncarnationId &&
          this.host.getPty(ptyId)?.incarnationId === expectedIncarnationId &&
          this.host.getPtyLivenessVerdict(ptyId)?.status === 'exited'
        ) {
          stopped = true
        }
        if (!stopped) {
          const verdict = this.host.getPtyLivenessVerdict(ptyId)
          const providerAlreadyRetiredPty =
            verdict?.status === 'unverifiable' &&
            verdict.reason === SSH_PROVIDER_UNREGISTERED_REASON
          if (!providerAlreadyRetiredPty) {
            this.controller.kill(ptyId)
            if (!verdict || verdict.status === 'live') {
              this.host.markPtyLivenessUnverifiable(
                ptyId,
                'a follow-up stop was issued but its outcome could not be verified'
              )
            }
          }
        }
      } else {
        stopped = this.controller?.kill(ptyId) ?? false
      }
      if (ptyId === addressedPtyId) {
        addressedPtyStop = { stopped }
      }
    }
    return addressedPtyStop
  }
}
