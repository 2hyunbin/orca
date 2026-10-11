import type { RuntimeMobileSessionReconciliation } from './session-tabs/mobile-session-reconciliation'
import { OrcaRuntimeWithWriteOrchestrationPointerPty } from './orca-runtime-write-orchestration-pointer-pty'

export class OrcaRuntimeWithSyncMobileSessionTabs extends OrcaRuntimeWithWriteOrchestrationPointerPty {
  // Returns the worktrees whose stored snapshot object changed during this
  // sync, so the caller can fan out only actually-changed worktrees.
  protected syncMobileSessionTabs(
    ...args: Parameters<RuntimeMobileSessionReconciliation['syncMobileSessionTabs']>
  ): ReturnType<RuntimeMobileSessionReconciliation['syncMobileSessionTabs']> {
    return this.runtimeMobileSessionReconciliation.syncMobileSessionTabs(...args)
  }
}
