import { session, type Session } from 'electron'
import { createPluginViewerDenyProxy } from './plugin-viewer-deny-proxy'
import {
  clearPluginViewerSession,
  preparePluginViewerSession
} from './plugin-viewer-session-policy'
import {
  PluginViewerSessionPool,
  type PluginViewerSessionLease,
  type PluginViewerSessionOwner
} from './plugin-viewer-session-pool'

type SessionRuntime = {
  pool: PluginViewerSessionPool<Session>
  bootstrapPages: Map<string, string>
  dispose(): Promise<void>
}

let runtime: SessionRuntime | undefined
let initialization: Promise<SessionRuntime> | undefined

async function initialize(): Promise<SessionRuntime> {
  const proxy = await createPluginViewerDenyProxy()
  const bootstrapPages = new Map<string, string>()
  const sessions = new Map<Session, string>()
  const pool = new PluginViewerSessionPool<Session>({
    getSession: (partition) => session.fromPartition(partition, { cache: false }),
    prepare: async (lease) => {
      sessions.set(lease.session, lease.id)
      await preparePluginViewerSession({
        lease,
        proxy,
        getBootstrap: () => bootstrapPages.get(lease.id) ?? '<!doctype html>',
        isCurrent: () => pool.isCurrent(lease)
      })
    },
    clear: async (privateSession) => {
      const id = sessions.get(privateSession)
      if (id) {
        bootstrapPages.delete(id)
      }
      sessions.delete(privateSession)
      await clearPluginViewerSession(privateSession)
    }
  })
  runtime = {
    pool,
    bootstrapPages,
    async dispose() {
      try {
        await pool.dispose()
      } finally {
        bootstrapPages.clear()
        await proxy.dispose()
      }
    }
  }
  return runtime
}

/** Only main-owned bootstrap HTML belongs here; author code stays in the parser worker. */
export async function acquirePluginViewerSession(
  owner: PluginViewerSessionOwner,
  bootstrap: string
): Promise<PluginViewerSessionLease<Session>> {
  initialization ??= initialize()
  const current = await initialization
  const lease = await current.pool.acquire(owner)
  current.bootstrapPages.set(lease.id, bootstrap)
  return lease
}

export function isPluginViewerSession(candidate: Session): boolean {
  return runtime?.pool.isPrivateSession(candidate) ?? false
}

export function reservePluginViewerAttach(
  hostWebContentsId: number,
  partition: string,
  url: string
): boolean {
  return runtime?.pool.reserveAttach(hostWebContentsId, partition, url) ?? false
}

export function getActivePluginViewerLease(
  candidate: Session
): PluginViewerSessionLease<Session> | null {
  return runtime?.pool.getActiveLease(candidate) ?? null
}

export function bindPluginViewerGuest(
  lease: PluginViewerSessionLease<Session>,
  hostWebContentsId: number,
  guest: Electron.WebContents
): boolean {
  return runtime?.pool.bindGuest(lease.id, hostWebContentsId, guest.session, guest) ?? false
}

export function isBoundPluginViewerGuest(
  lease: PluginViewerSessionLease<Session>,
  guest: Electron.WebContents
): boolean {
  return runtime?.pool.isBoundGuest(lease, guest) ?? false
}

export async function retirePluginViewerSession(id: string): Promise<void> {
  await runtime?.pool.retire(id)
}

export async function retirePluginViewerHost(hostWebContentsId: number): Promise<void> {
  await runtime?.pool.retireOwner(hostWebContentsId)
}

export async function disposePluginViewerSessions(): Promise<void> {
  if (initialization) {
    await (await initialization).dispose()
  }
}
