import { randomUUID } from 'node:crypto'
import { PLUGIN_VIEWER_SESSION_LIMIT } from '../../shared/plugins/plugin-viewer-document'

export { PLUGIN_VIEWER_SESSION_LIMIT } from '../../shared/plugins/plugin-viewer-document'
export const PLUGIN_VIEWER_SCHEME = 'orca-plugin-viewer'

export type PluginViewerSessionOwner = Readonly<{
  hostWebContentsId: number
  tabId: string
  pluginKey: string
  pluginGeneration: number
}>

export type PluginViewerSessionLease<Session> = Readonly<{
  id: string
  partition: string
  url: string
  session: Session
  owner: PluginViewerSessionOwner
}>

type ViewerGuest = {
  isDestroyed(): boolean
  once(event: 'destroyed', listener: () => void): unknown
  removeListener(event: 'destroyed', listener: () => void): unknown
  close(options: { waitForBeforeUnload: false }): void
}

type Slot<Session> = {
  partition: string
  session?: Session
  state: 'idle' | 'preparing' | 'active' | 'retiring' | 'quarantined'
  lease?: PluginViewerSessionLease<Session>
  guest?: ViewerGuest
  attachmentReserved?: boolean
  preparation?: Promise<PluginViewerSessionLease<Session>>
  retirement?: Promise<void>
}

type PoolDependencies<Session> = {
  getSession(partition: string): Session
  prepare(lease: PluginViewerSessionLease<Session>): Promise<void>
  clear(session: Session): Promise<void>
}

export class PluginViewerSessionPool<Session> {
  private readonly slots: Slot<Session>[]
  private readonly operations = new Set<Promise<unknown>>()
  private closed = false

  constructor(private readonly dependencies: PoolDependencies<Session>) {
    const namespace = randomUUID()
    this.slots = Array.from({ length: PLUGIN_VIEWER_SESSION_LIMIT }, (_, index) => ({
      partition: `orca-plugin-viewer-${namespace}-${index}`,
      state: 'idle'
    }))
  }

  acquire(owner: PluginViewerSessionOwner): Promise<PluginViewerSessionLease<Session>> {
    if (this.closed) {
      return Promise.reject(new Error('plugin_viewer_pool_closed'))
    }
    const slot = this.slots.find((candidate) => candidate.state === 'idle')
    if (!slot) {
      return Promise.reject(new Error('plugin_viewer_session_limit'))
    }
    slot.state = 'preparing'
    slot.preparation = this.track(this.prepare(slot, Object.freeze({ ...owner })))
    return slot.preparation
  }

  isPrivateSession(session: Session): boolean {
    return this.slots.some((slot) => slot.session === session)
  }

  isAdmissibleAttach(hostWebContentsId: number, partition: string, url: string): boolean {
    return this.slots.some(
      (slot) =>
        slot.state === 'active' &&
        !slot.attachmentReserved &&
        !slot.guest &&
        slot.partition === partition &&
        slot.lease?.url === url &&
        slot.lease.owner.hostWebContentsId === hostWebContentsId
    )
  }

  reserveAttach(hostWebContentsId: number, partition: string, url: string): boolean {
    if (!this.isAdmissibleAttach(hostWebContentsId, partition, url)) {
      return false
    }
    const slot = this.slots.find((candidate) => candidate.partition === partition)
    if (!slot) {
      return false
    }
    slot.attachmentReserved = true
    return true
  }

  getActiveLease(session: Session): PluginViewerSessionLease<Session> | null {
    return (
      this.slots.find((slot) => slot.state === 'active' && slot.session === session)?.lease ?? null
    )
  }

  bindGuest(
    leaseId: string,
    hostWebContentsId: number,
    session: Session,
    guest: ViewerGuest
  ): boolean {
    const slot = this.activeSlot(leaseId)
    if (
      !slot ||
      !slot.attachmentReserved ||
      slot.guest ||
      guest.isDestroyed() ||
      slot.session !== session ||
      slot.lease?.owner.hostWebContentsId !== hostWebContentsId
    ) {
      return false
    }
    slot.guest = guest
    return true
  }

  isCurrent(lease: PluginViewerSessionLease<Session>): boolean {
    return this.activeSlot(lease.id)?.lease === lease
  }

  isBoundGuest(lease: PluginViewerSessionLease<Session>, guest: ViewerGuest): boolean {
    return this.isCurrent(lease) && this.activeSlot(lease.id)?.guest === guest
  }

  retire(leaseId: string): Promise<void> {
    const slot = this.slots.find((candidate) => candidate.lease?.id === leaseId)
    if (!slot) {
      return Promise.resolve()
    }
    if (slot.retirement) {
      return slot.retirement
    }
    // Withdraw admission before waiting for the renderer or storage cleanup.
    slot.state = 'retiring'
    slot.retirement = this.track(this.clearSlot(slot))
    return slot.retirement
  }

  async retireOwner(hostWebContentsId: number): Promise<void> {
    await Promise.all(
      this.slots
        .filter((slot) => slot.lease?.owner.hostWebContentsId === hostWebContentsId)
        .map((slot) => this.retire(slot.lease?.id ?? ''))
    )
  }

  async dispose(): Promise<void> {
    this.closed = true
    await Promise.allSettled(
      this.slots.flatMap((slot) => (slot.lease ? [this.retire(slot.lease.id)] : []))
    )
    while (this.operations.size) {
      await Promise.allSettled(this.operations)
    }
  }

  private activeSlot(id: string): Slot<Session> | undefined {
    return this.slots.find((slot) => slot.state === 'active' && slot.lease?.id === id)
  }

  private track<Result>(operation: Promise<Result>): Promise<Result> {
    this.operations.add(operation)
    void operation.then(
      () => this.operations.delete(operation),
      () => this.operations.delete(operation)
    )
    return operation
  }

  private async prepare(
    slot: Slot<Session>,
    owner: PluginViewerSessionOwner
  ): Promise<PluginViewerSessionLease<Session>> {
    try {
      slot.session ??= this.dependencies.getSession(slot.partition)
      const id = randomUUID()
      const lease = Object.freeze({
        id,
        partition: slot.partition,
        url: `${PLUGIN_VIEWER_SCHEME}://${id}/`,
        session: slot.session,
        owner
      })
      slot.lease = lease
      await this.dependencies.prepare(lease)
      if (this.closed || slot.state !== 'preparing') {
        throw new Error('plugin_viewer_pool_closed')
      }
      slot.state = 'active'
      return lease
    } catch (error) {
      if (slot.state === 'retiring') {
        throw error
      }
      // A failed prepare can leave partial policy; quarantine instead of reusing it.
      slot.state = 'quarantined'
      if (slot.session !== undefined) {
        await this.dependencies.clear(slot.session).catch(() => {})
      }
      slot.lease = undefined
      throw error
    }
  }

  private async clearSlot(slot: Slot<Session>): Promise<void> {
    try {
      await slot.preparation?.catch(() => {})
      await this.closeGuest(slot.guest)
      if (slot.session !== undefined) {
        await this.dependencies.clear(slot.session)
      }
      slot.state = 'idle'
    } catch (error) {
      slot.state = 'quarantined'
      throw error
    } finally {
      slot.guest = undefined
      slot.attachmentReserved = undefined
      slot.lease = undefined
      slot.retirement = undefined
      slot.preparation = undefined
    }
  }

  private async closeGuest(guest: ViewerGuest | undefined): Promise<void> {
    if (!guest || guest.isDestroyed()) {
      return
    }
    await new Promise<void>((resolve, reject) => {
      const destroyed = (): void => resolve()
      guest.once('destroyed', destroyed)
      try {
        guest.close({ waitForBeforeUnload: false })
      } catch (error) {
        guest.removeListener('destroyed', destroyed)
        reject(error)
      }
    })
  }
}
