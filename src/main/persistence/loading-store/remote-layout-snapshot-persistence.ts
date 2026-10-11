import type { RemoteLayoutSnapshot } from '../../../shared/remote-layout-snapshot'
import type { StoreRuntimeState } from './store-runtime-state'
import type { WriteSchedulingOperations } from './write-scheduling'
import { scheduleSave } from './write-scheduling'

type RemoteLayoutSnapshotRuntime = Pick<StoreRuntimeState, 'state'>

const remoteLayoutSnapshotPersistenceContext = Symbol('RemoteLayoutSnapshotPersistence')
type RemoteLayoutSnapshotPersistenceContext = {
  runtime: RemoteLayoutSnapshotRuntime
  scheduling: WriteSchedulingOperations
}

export class RemoteLayoutSnapshotPersistence {
  readonly [remoteLayoutSnapshotPersistenceContext]: RemoteLayoutSnapshotPersistenceContext

  constructor(runtime: RemoteLayoutSnapshotRuntime, scheduling: WriteSchedulingOperations) {
    this[remoteLayoutSnapshotPersistenceContext] = { runtime, scheduling }
  }

  getRemoteLayoutSnapshot(environmentId: string): RemoteLayoutSnapshot | undefined {
    return this[remoteLayoutSnapshotPersistenceContext].runtime.state.remoteLayoutSnapshots?.[
      environmentId
    ]
  }

  /** Only the recorder calls this (ratchet in remote-layout-snapshot-recorder.test.ts). */
  setRemoteLayoutSnapshot(environmentId: string, snapshot: RemoteLayoutSnapshot | null): void {
    const { runtime, scheduling } = this[remoteLayoutSnapshotPersistenceContext]
    const { [environmentId]: previous, ...others } = runtime.state.remoteLayoutSnapshots ?? {}
    if (snapshot === null && previous === undefined) {
      return
    }
    runtime.state.remoteLayoutSnapshots = snapshot
      ? { ...others, [environmentId]: snapshot }
      : others
    // Named so the save writes only this domain and wakes no workspace-session listener.
    scheduleSave(scheduling, ['remoteLayoutSnapshots'])
  }
}
