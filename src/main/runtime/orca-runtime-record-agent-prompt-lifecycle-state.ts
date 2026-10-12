import { OrcaRuntimeWithCreateTerminalSideEffectCommandCodeDetector } from './orca-runtime-create-terminal-side-effect-command-code-detector'
import type { AgentStatus } from '../../shared/agent-detection'
import { getDisplayPromptLifecycle } from './runtime-worktree-status-projection'
import { findLastCompleteOscTitleRange } from './orca-runtime-core'
import { extractLastOscTitle } from '../../shared/osc-title-extraction'
import { detectAgentStatusFromTitle } from '../../shared/agent-detection'
import type { RuntimeTerminalDataMeta } from './runtime-terminal-stream-consumers'

export abstract class OrcaRuntimeWithRecordAgentPromptLifecycleState extends OrcaRuntimeWithCreateTerminalSideEffectCommandCodeDetector {
  protected recordAgentPromptLifecycleState(ptyId: string, status: AgentStatus | null): void {
    if (status === 'permission') {
      this.recordAgentPromptPermissionObservation(ptyId)
    }
    const current = this.agentPromptLifecycleByPtyId.get(ptyId)
    // Why projected: main recorded a stale-working clear here, so the next working status after
    // one starts a new turn for prompt verification, as it did there.
    const previousStatus = getDisplayPromptLifecycle(
      current,
      this.getPtyTitleDisplayClear(ptyId)
    )?.status
    const updatedAt = Date.now()
    if (!current) {
      this.agentPromptLifecycleByPtyId.set(ptyId, {
        status,
        workingSequence: status === 'working' ? 1 : 0,
        updatedAt
      })
      return
    }
    this.agentPromptLifecycleByPtyId.set(ptyId, {
      status,
      workingSequence:
        current.workingSequence + (status === 'working' && previousStatus !== 'working' ? 1 : 0),
      updatedAt
    })
  }

  protected recordAgentPromptPermissionObservation(ptyId: string): void {
    this.agentPromptPermissionSequenceByPtyId.set(
      ptyId,
      (this.agentPromptPermissionSequenceByPtyId.get(ptyId) ?? 0) + 1
    )
  }

  protected restoreAgentPromptLifecycleByteOrder(
    ptyId: string,
    titleInput: string,
    lastPayloadTitleOffset: number | null
  ): void {
    if (lastPayloadTitleOffset === null) {
      return
    }
    const titleRange = findLastCompleteOscTitleRange(titleInput)
    if (!titleRange || titleRange.end <= lastPayloadTitleOffset) {
      return
    }
    const title = extractLastOscTitle(titleInput)
    if (title === null) {
      return
    }
    const status = detectAgentStatusFromTitle(title)
    const current = this.agentPromptLifecycleByPtyId.get(ptyId)
    if (!current || current.status === status) {
      return
    }
    this.agentPromptLifecycleByPtyId.set(ptyId, {
      status,
      workingSequence:
        current.workingSequence + (status === 'working' && current.status !== 'working' ? 1 : 0),
      updatedAt: Date.now()
    })
  }

  getPtyOutputSequence(ptyId: string): number {
    return this.terminalOutput.getPtyOutputSequence(ptyId)
  }

  protected getPtyLifecycleGeneration(ptyId: string): number {
    return this.terminalOutput.getPtyLifecycleGeneration(ptyId)
  }

  protected advancePtyLifecycleGeneration(ptyId: string): void {
    return this.terminalOutput.advancePtyLifecycleGeneration(ptyId)
  }

  synchronizePtyOutputSequenceFromProvider(
    ptyId: string,
    providerSequence: { value: number; generation: 'continued' | 'reset' },
    runtimeSequenceAtSpawnStart = 0
  ): number {
    return this.terminalOutput.synchronizePtyOutputSequenceFromProvider(
      ptyId,
      providerSequence,
      runtimeSequenceAtSpawnStart
    )
  }

  subscribeToTerminalData(
    ptyId: string,
    listener: (data: string, meta?: RuntimeTerminalDataMeta) => void
  ): () => void {
    return this.terminalStreamConsumers.subscribe(ptyId, listener)
  }
}
