import type {
  LayoutApplyOutcome,
  LayoutCommand
} from '../../../shared/workspace-layout/workspace-layout-command-types'
import {
  resolveHostId,
  type SessionHostPartitionOperations
} from '../loading-store/session-host-partitions'
import type { StoreRuntimeState } from '../loading-store/store-runtime-state'
import { applyLayout, topologyCommitContext } from './terminal-topology-commit'
import {
  repairDuplicatePtyPanesMutation,
  type DuplicatePtyPaneTransfer
} from './duplicate-pty-pane-repair'

type LayoutCommandRuntime = Pick<
  StoreRuntimeState,
  'runDurableMutation' | 'state' | 'dirtyProfileStateDomains' | 'writesFrozen'
>

const layoutCommandPersistenceContext = Symbol('LayoutCommandPersistence')
type LayoutCommandPersistenceContext = {
  runtime: LayoutCommandRuntime
  sessions: SessionHostPartitionOperations
}

/** The Store's half of `layout.apply`; the commit module owns the write. */
export class LayoutCommandPersistence {
  readonly [layoutCommandPersistenceContext]: LayoutCommandPersistenceContext

  constructor(runtime: LayoutCommandRuntime, sessions: SessionHostPartitionOperations) {
    this[layoutCommandPersistenceContext] = { runtime, sessions }
  }

  /** Applies to each partition holding the command's tab, routed partition first (local if none). */
  applyLayoutCommand(
    command: LayoutCommand,
    hostIds: readonly string[] = []
  ): Promise<LayoutApplyOutcome> {
    const context = this[layoutCommandPersistenceContext]
    const resolved = hostIds.length > 0 ? hostIds.map(resolveHostId) : [resolveHostId()]
    return context.runtime.runDurableMutation(
      applyLayout(resolved, command, topologyCommitContext(context))
    )
  }

  /**
   * Layout-owner builds, once a runtime starts: one pane per terminal on disk, written only after
   * `transfer` moved each dropped pane's owners. Resolves the number of partitions repaired.
   */
  repairDuplicatePtyPanes(transfer: (move: DuplicatePtyPaneTransfer) => boolean): Promise<number> {
    const context = this[layoutCommandPersistenceContext]
    // An imported or frozen profile neither writes nor moves owners.
    if (context.runtime.writesFrozen) {
      return Promise.resolve(0)
    }
    return context.runtime.runDurableMutation(
      repairDuplicatePtyPanesMutation(topologyCommitContext(context), transfer)
    )
  }
}
