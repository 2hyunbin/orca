import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import { composeWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import { ProducerRevision } from './producer-revision'

type FreshReads = {
  afterFreshRead: (environmentId: string, done: (read: boolean) => void) => void
}

export type PairedServerMetaTarget = { environmentId: string; worktreeId: string }

type FieldWrites = { tail: Promise<void>; saving: number }

/**
 * A paired server's metadata edits (pin, rename, status, order, read state), forwarded one at a
 * time per row and field. Each field reads `saving` until the server's rows are read afresh after
 * the write's reply, under the same contact; an echo of the value never settles it, so an older
 * identical row or a reordered reply cannot settle a newer edit. Losing contact ends the hint.
 */
export class PairedServerMetaWrites {
  readonly revision = new ProducerRevision()
  private readonly fields = new Map<string, Map<string, FieldWrites>>()

  constructor(private readonly reads: FreshReads) {}

  /** Sends after every earlier write of the same row and field has answered; returns its reply. */
  write<T>(target: PairedServerMetaTarget, field: string, send: () => Promise<T>): Promise<T> {
    const rowKey = composeWorktreeHostIdentity(
      toRuntimeExecutionHostId(target.environmentId),
      target.worktreeId
    )
    const byField = this.fields.get(rowKey) ?? new Map<string, FieldWrites>()
    this.fields.set(rowKey, byField)
    const writes = byField.get(field) ?? { tail: Promise.resolve(), saving: 0 }
    byField.set(field, writes)
    writes.saving += 1
    this.revision.bump({ urgent: true })
    const settle = (): void => {
      writes.saving -= 1
      if (writes.saving === 0 && byField.get(field) === writes) {
        byField.delete(field)
        if (byField.size === 0) {
          this.fields.delete(rowKey)
        }
      }
      this.revision.bump()
    }
    const reply = writes.tail.then(send)
    writes.tail = reply.then(
      () => undefined,
      () => undefined
    )
    reply.then(
      () => this.reads.afterFreshRead(target.environmentId, settle),
      // A refused write changed nothing to wait for.
      settle
    )
    return reply
  }

  /** The fields still saving, per paired-server row key. */
  saving(): Record<string, string[]> {
    return Object.fromEntries(
      [...this.fields].map(([rowKey, byField]) => [rowKey, [...byField.keys()].sort()])
    )
  }
}
