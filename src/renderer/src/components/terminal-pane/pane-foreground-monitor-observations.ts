import type { RecognizedAgentProcess } from '../../../../shared/agent-process-recognition'
import { resolveCompatibleAgentTypeForOwner } from '../../../../shared/agent-title-owner'
import type {
  PaneForegroundAgentTracker,
  PaneForegroundAgentTrackerDeps
} from './pane-foreground-agent-tracker-contract'

type MonitorObservationContext = {
  deps: PaneForegroundAgentTrackerDeps
  isDisposed: () => boolean
  cancelPendingRead: () => void
  hasCommandReadInFlight: () => boolean
  markForegroundAgentEvidence: () => void
  clearAgentEvidence: () => void
}

/** Process-monitor observations folded into the tracker's published foreground entry. */
export function createMonitorObservationHandlers(
  ctx: MonitorObservationContext
): Pick<
  PaneForegroundAgentTracker,
  'onForegroundAgentObserved' | 'onShellForegroundObserved' | 'onProcessExitConfirmed'
> {
  return {
    onForegroundAgentObserved(process: RecognizedAgentProcess): void {
      if (ctx.isDisposed()) {
        return
      }
      const published = ctx.deps.getPublishedEntry?.()
      // A cadence read cannot grant bytes while a fresh routing confirmation is owed.
      if (
        ctx.hasCommandReadInFlight() ||
        published?.routingRevoked ||
        published?.routingConfirmationPending
      ) {
        return
      }
      ctx.cancelPendingRead()
      ctx.markForegroundAgentEvidence()
      ctx.deps.publish({
        agent: process.agent,
        agentEvidence: 'process-read',
        routingTrusted: true,
        shellForeground: false
      })
      ctx.deps.onVisibleForegroundSettled?.('agent')
    },
    onShellForegroundObserved(): void {
      if (ctx.isDisposed()) {
        return
      }
      ctx.cancelPendingRead()
      ctx.deps.publish({ agent: null, shellForeground: true })
    },
    onProcessExitConfirmed(process: RecognizedAgentProcess): void {
      if (ctx.isDisposed()) {
        return
      }
      const published = ctx.deps.getPublishedEntry?.()
      ctx.cancelPendingRead()
      ctx.clearAgentEvidence()
      // Display ownership only guards this write, never accepted exit delivery to other consumers.
      if (
        published?.shellForeground ||
        (published?.agentEvidence === 'process-read' &&
          resolveCompatibleAgentTypeForOwner(process.agent, published.agent) === published.agent)
      ) {
        ctx.deps.publish({ agent: null, shellForeground: published.shellForeground })
      }
    }
  }
}
