import type { RuntimeLeafRecord } from '../../runtime-terminal-state-records'

import { resolveStructuredWorkerAuthority } from '../../structured-worker-authority'
import type {
  StructuredPointerTarget,
  OrchestrationStructuredMailboxPointerDelivery
} from '../structured-mailbox-pointer-delivery'
import {
  chatDispatchMailTarget,
  handleLessCoordinatorSessionId,
  structuredSessionAddressTarget,
  structuredSessionMailTarget,
  structuredSessionIdleEdgeMailboxes
} from '../structured-session-mail-target'
import { exitedChatDispatchesForSession } from '../chat-assignee'
import {
  OPERATOR_CLOSE_EXIT_CAUSE,
  type TerminalExitCause
} from '../../../../shared/terminal-exit-cause'

import type { OrchestrationDb } from '../db'
import type { MailPointerRepointScheduler } from '../mail-pointer-repoint-scheduler'
import type { OrchestrationMailboxNotificationCoordinator } from '../mailbox-notification-coordinator'

import type { OrchestrationMailboxOwner } from '../mailbox-owner'
import type { RuntimeMessageWaiter } from '../../runtime-message-waiters'

type RuntimeMailboxControlHost = {
  notifyStructuredSessionJournalActivity(): (sessionId: string) => void
  deliverPendingMessagesForHandle(): (handle: string, reservedTypes?: ReadonlySet<string>) => void
  resolveStructuredCoordinatorMailboxTarget(): (runId: string) => StructuredPointerTarget | null
  resolveStructuredWorkerDirectMailboxTarget(): (handle: string) => StructuredPointerTarget | null
  getDb(): OrchestrationDb | null
  getExistingOrchestrationDb(): () => OrchestrationDb | null
  getNotifications(): Pick<
    OrchestrationMailboxNotificationCoordinator<RuntimeMessageWaiter>,
    'deliverForHandle' | 'deliverForLeaf' | 'notifyMessageArrived'
  >
  getStructuredPointerDelivery(): Pick<
    OrchestrationStructuredMailboxPointerDelivery<RuntimeMessageWaiter>,
    'onJournalActivity' | 'forgetSession'
  >
  getMailboxOwner(): Pick<OrchestrationMailboxOwner, 'routeDetachedDirectMessages'>
  failActiveDispatchOnExit(): (
    handle: string,
    paneKey: string | null,
    exitCode: number,
    cause: TerminalExitCause
  ) => void
}
export class RuntimeMailboxControl {
  constructor(
    private readonly host: RuntimeMailboxControlHost,
    readonly mailPointerRepointScheduler: MailPointerRepointScheduler
  ) {}
  deliverPendingMessagesForHandle(handle: string, reservedTypes?: ReadonlySet<string>): void {
    this.host.getNotifications().deliverForHandle(handle, reservedTypes)
  }
  notifyStructuredSessionJournalActivity(sessionId: string): void {
    this.host.getStructuredPointerDelivery().onJournalActivity(sessionId)
  }
  onStructuredSessionStatusForMail(summary: {
    sessionId: string
    status: 'working' | 'attention' | 'idle' | null
  }): void {
    if (summary.status === 'working' || summary.status === 'attention') {
      return
    }
    // Logged, never thrown: the same status callback goes on to the first-turn workspace rename.
    try {
      this.host.notifyStructuredSessionJournalActivity()(summary.sessionId)
      const openDb = () => this.host.getExistingOrchestrationDb()()
      const deliver = (mailbox: string) => this.host.deliverPendingMessagesForHandle()(mailbox)
      structuredSessionIdleEdgeMailboxes(summary.sessionId, openDb).forEach(deliver)
    } catch (error) {
      console.warn('[orchestration] structured session mail redrive failed', {
        sessionId: summary.sessionId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
  onStructuredSessionTabHidden(sessionId: string): void {
    try {
      const db = this.host.getExistingOrchestrationDb()()
      for (const dispatch of db ? exitedChatDispatchesForSession(sessionId, db) : []) {
        this.host.failActiveDispatchOnExit()(
          dispatch.assignee_handle,
          null,
          0,
          OPERATOR_CLOSE_EXIT_CAUSE
        )
      }
    } catch (error) {
      console.warn('[orchestration] settling a closed chat worker failed', {
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
  forgetStructuredSessionMail(sessionId: string): void {
    this.host.getStructuredPointerDelivery().forgetSession(sessionId)
  }
  resolveStructuredMailboxTarget(mailboxHandle: string): StructuredPointerTarget | null {
    if (mailboxHandle.startsWith('run:')) {
      return this.host.resolveStructuredCoordinatorMailboxTarget()(
        mailboxHandle.slice('run:'.length)
      )
    }
    const addressed = structuredSessionAddressTarget(mailboxHandle, this.host.getDb())
    if (addressed !== undefined) {
      return addressed
    }
    if (!mailboxHandle.startsWith('dispatch:')) {
      return this.host.resolveStructuredWorkerDirectMailboxTarget()(mailboxHandle)
    }
    const dispatchId = mailboxHandle.slice('dispatch:'.length)
    const dispatch = this.host.getDb()?.getDispatchContextById?.(dispatchId)
    const assignee = dispatch?.assignee_handle
    if (!assignee) {
      return null
    }
    const chat = chatDispatchMailTarget(dispatch, this.host.getDb())
    if (chat !== undefined) {
      return chat
    }
    const sessionId = this.liveStructuredWorkerSessionId(assignee)
    return sessionId ? { sessionId, dispatchId } : null
  }
  resolveStructuredCoordinatorMailboxTarget(runId: string): StructuredPointerTarget | null {
    const run = this.host.getDb()?.getRun?.(runId)
    const sessionId = run ? handleLessCoordinatorSessionId(run) : null
    if (sessionId) {
      return structuredSessionMailTarget(sessionId, this.host.getDb())
    }
    const coordinator = run?.coordinator_handle
    if (!coordinator) {
      return null
    }
    const workerSessionId = this.liveStructuredWorkerSessionId(coordinator)
    return workerSessionId ? { sessionId: workerSessionId, dispatchId: null } : null
  }
  resolveStructuredWorkerDirectMailboxTarget(handle: string): StructuredPointerTarget | null {
    const db = this.host.getDb()
    // Answers null for anything that is not a live structured worker of THIS runtime, so `run:`
    // and PTY handles fall through to the PTY lane exactly as before.
    const authority = resolveStructuredWorkerAuthority(handle, db)
    if (!authority) {
      return null
    }
    const dispatchId =
      db?.findActiveDispatchForAssignee?.(handle, authority.identity.paneKey)?.id ?? null
    return { sessionId: authority.running.sessionId, dispatchId }
  }
  private liveStructuredWorkerSessionId(handle: string): string | null {
    return resolveStructuredWorkerAuthority(handle, this.host.getDb())?.running.sessionId ?? null
  }
  scheduleRestoredMessageRepoints(): void {
    let handles: Set<string>
    try {
      const db = this.host.getDb()
      // Pointer-phase rows are excluded from the undelivered scan, so they need their own.
      handles = new Set([
        ...(db?.getUndeliveredUnreadMailboxHandles?.() ?? []),
        ...(db?.getPendingMailboxPointerHandles?.() ?? [])
      ])
    } catch (error) {
      console.warn('[orchestration] failed to scan restored mailboxes', error)
      return
    }
    for (const handle of handles) {
      try {
        if (handle.startsWith('run:') || handle.startsWith('dispatch:')) {
          this.mailPointerRepointScheduler.schedule(handle)
          continue
        }
        const routed = this.host.getMailboxOwner().routeDetachedDirectMessages(handle)
        for (const mailbox of routed.mailboxes) {
          this.mailPointerRepointScheduler.schedule(mailbox.mailboxHandle)
        }
        if (!routed.hasMore) {
          this.mailPointerRepointScheduler.schedule(handle)
        }
      } catch (error) {
        console.warn(`[orchestration] failed to restore mailbox ${handle}`, error)
        this.mailPointerRepointScheduler.schedule(handle)
      }
    }
  }
  repointPendingMessagesForHandle(handle: string): void {
    try {
      this.host.deliverPendingMessagesForHandle()(handle)
    } catch {
      // The unref'd repair can outlive a test/runtime-owned database during shutdown.
    }
  }
  deliverPendingMessagesForLeaf(leaf: RuntimeLeafRecord): void {
    this.host.getNotifications().deliverForLeaf(leaf)
  }
  notifyMessageArrived(handle: string, messageType?: string): void {
    if (!handle.startsWith('dispatch:')) {
      this.mailPointerRepointScheduler.schedule(handle)
    }
    this.host.getNotifications().notifyMessageArrived(handle, messageType)
  }
}
