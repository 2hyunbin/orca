import type { IPtyProvider } from '../providers/pty-provider-contract'
import type { OwnerInventory } from './daemon-session-owner-inventory'
import type {
  DaemonOwnerInventoryQueue,
  PendingOwnerInventory
} from './daemon-session-owner-inventory-acquisition'
import { TerminalSessionOwnerUnverifiedError } from './daemon-errors'
import { awaitDaemonWorkWithinCallerDeadline } from './daemon-request-deadline'

export async function readDaemonOwnerInventory<T extends IPtyProvider>(
  queue: DaemonOwnerInventoryQueue<T>,
  currentEpoch: () => number,
  acceptsBorrowed: (inventory: OwnerInventory<T>) => boolean,
  deadlineMs: number,
  replaceEstablishedRoutes: boolean
): Promise<{ value: OwnerInventory<T>; release: () => void }> {
  let reader = queue.acquire({ fresh: false, replaceEstablishedRoutes, deadlineMs })
  try {
    let completed = await awaitDaemonWorkWithinCallerDeadline(
      reader.pending.promise.then(() => {}),
      deadlineMs
    )
    let inventory = completed ? await reader.pending.promise : reader.snapshot()
    if (!reader.fresh) {
      // Pre-boundary observations carry positive proof only.
      inventory = { ...inventory, complete: false }
      if (completed && !acceptsBorrowed(inventory) && inventory.epoch === currentEpoch()) {
        reader.release()
        reader = queue.acquire({ fresh: true, replaceEstablishedRoutes, deadlineMs })
        completed = await awaitDaemonWorkWithinCallerDeadline(
          reader.pending.promise.then(() => {}),
          deadlineMs
        )
        inventory = completed ? await reader.pending.promise : reader.snapshot()
      }
    }
    return { value: inventory, release: reader.release }
  } catch (error) {
    reader.release()
    throw error
  }
}

export async function awaitDaemonOwnerInventory<T extends IPtyProvider>(
  pending: PendingOwnerInventory<T>,
  currentEpoch: () => number,
  deadlineMs?: number
): Promise<OwnerInventory<T>> {
  if (
    deadlineMs !== undefined &&
    !(await awaitDaemonWorkWithinCallerDeadline(
      pending.promise.then(() => {}),
      deadlineMs
    ))
  ) {
    throw new TerminalSessionOwnerUnverifiedError('inventory deadline')
  }
  const inventory = await pending.promise
  if (inventory.epoch !== currentEpoch()) {
    throw new TerminalSessionOwnerUnverifiedError('stale inventory')
  }
  if (inventory.failure) {
    throw inventory.failure.error
  }
  return inventory
}
