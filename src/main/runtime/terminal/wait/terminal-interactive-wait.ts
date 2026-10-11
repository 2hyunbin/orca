import type {
  RuntimeTerminalAgentStatus,
  RuntimeTerminalInteractiveWait,
  RuntimeTerminalWaitBlockedReason
} from '../../../../shared/runtime-types'
import type { RuntimeTerminalAgentStatusSnapshot } from '../../runtime-terminal-agent-status-query'
import type { AgentStatus } from '../../../../shared/agent-detection'
import { withTimeout } from '../../runtime-async-boundaries'
import { TERMINAL_INTERACTIVE_WAIT_PROBE_TIMEOUT_MS } from '../../orca-runtime-core'

type ExplicitAgentStatus = { status: AgentStatus; updatedAt: number }
type TerminalWaitPermissionInputs = {
  terminal: RuntimeTerminalAgentStatusSnapshot
  lifecycle: { status: AgentStatus | null; updatedAt: number } | null | undefined
}
type TerminalInteractiveWaitHost = {
  getTerminalAgentStatusPtyId(handle: string): string
  getTerminalWaitPermissionInputs(handle: string, ptyId: string): TerminalWaitPermissionInputs
  getFreshExplicitAgentStatusForHandle(handle: string): ExplicitAgentStatus | null
  resolveAuthoritativeTerminalWaitPermission(
    terminal: RuntimeTerminalAgentStatusSnapshot,
    explicit: ExplicitAgentStatus | null,
    lifecycle: TerminalWaitPermissionInputs['lifecycle']
  ): RuntimeTerminalWaitBlockedReason | null
  getTerminalAgentStatus(handle: string): Promise<RuntimeTerminalAgentStatus>
}

export class TerminalInteractiveWait {
  private readonly interactiveWaitProbesByPtyId = new Map<
    string,
    Promise<RuntimeTerminalAgentStatus | undefined>
  >()

  constructor(private readonly host: TerminalInteractiveWaitHost) {}

  async getTerminalInteractiveWait(
    handle: string
  ): Promise<RuntimeTerminalInteractiveWait | null | undefined> {
    let ptyId: string
    let inputs: {
      terminal: RuntimeTerminalAgentStatusSnapshot
      lifecycle: { status: AgentStatus | null; updatedAt: number } | null | undefined
    }
    try {
      ptyId = this.host.getTerminalAgentStatusPtyId(handle)
      inputs = this.host.getTerminalWaitPermissionInputs(handle, ptyId)
    } catch {
      return undefined
    }
    const { terminal, lifecycle } = inputs
    const explicitStatus = this.host.getFreshExplicitAgentStatusForHandle(handle)
    const promptReason = this.host.resolveAuthoritativeTerminalWaitPermission(
      terminal,
      explicitStatus,
      lifecycle
    )
    if (promptReason) {
      return {
        source: 'prompt-text',
        reason: promptReason,
        ...(terminal.waitBlockedAt !== null ? { since: terminal.waitBlockedAt } : {})
      }
    }
    if (terminal.titleStatus === 'permission' && terminal.titleStatusIsLive) {
      return { source: 'title' }
    }
    if (explicitStatus?.status !== 'permission') {
      return null
    }
    const status = await withTimeout(
      this.probeAgentStatusOncePerPty(handle, ptyId),
      TERMINAL_INTERACTIVE_WAIT_PROBE_TIMEOUT_MS,
      undefined
    )
    if (!status) {
      return undefined
    }
    return status.isRunningAgent && status.status === 'permission'
      ? { source: 'hook', since: explicitStatus.updatedAt }
      : null
  }

  private probeAgentStatusOncePerPty(
    handle: string,
    ptyId: string
  ): Promise<RuntimeTerminalAgentStatus | undefined> {
    const inFlight = this.interactiveWaitProbesByPtyId.get(ptyId)
    if (inFlight) {
      return inFlight
    }
    const probe = this.host
      .getTerminalAgentStatus(handle)
      .catch(() => undefined)
      .finally(() => {
        if (this.interactiveWaitProbesByPtyId.get(ptyId) === probe) {
          this.interactiveWaitProbesByPtyId.delete(ptyId)
        }
      })
    this.interactiveWaitProbesByPtyId.set(ptyId, probe)
    return probe
  }
}
