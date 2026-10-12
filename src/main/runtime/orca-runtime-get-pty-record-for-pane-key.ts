// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { RuntimeTerminalPromptAgentPresence } from './terminal/status/terminal-agent-presence'
import type { RuntimeTerminalAgentPresenceOptions } from './runtime-terminal-agent-presence'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import type { RuntimeMailboxControl } from './orchestration/mail/runtime-mailbox-control'

import type { RuntimeTerminalIdentity } from './terminal-identity-probe'

export class OrcaRuntimeWithGetPtyRecordForPaneKey extends RuntimeTerminalPromptAgentPresence {
  protected getPtyRecordForPaneKey(paneKey: string): RuntimePtyWorktreeRecord | null {
    return this.terminalIdentity.getPtyRecordForPaneKey(paneKey)
  }

  protected getPaneKeyForTerminalHandle(handle: string): string | null {
    return this.terminalIdentity.getPaneKeyForTerminalHandle(handle)
  }

  getTerminalWorktreeIdForHandle(handle: string): string | null {
    return this.terminalIdentity.getTerminalWorktreeIdForHandle(handle)
  }

  protected setPtyManagementTitleFromObservedTitle(
    pty: RuntimePtyWorktreeRecord,
    title: string | null | undefined,
    observedAt: number
  ): void {
    return this.terminalIdentity.setPtyManagementTitleFromObservedTitle(pty, title, observedAt)
  }

  protected nextTitleObservationSequence(): number {
    return this.terminalIdentity.nextTitleObservationSequence()
  }

  // Why: title is the tightest agent-presence signal, but a Claude management title is negative evidence for task activity.
  async isTerminalRunningAgent(
    handle: string,
    options?: RuntimeTerminalAgentPresenceOptions
  ): Promise<boolean> {
    return this.terminalAgentPresence.isRunning(handle, options)
  }

  /**
   * The identity seam: whether this handle still names a live agent identity, in either lane.
   *
   * Read-only by construction — a handle and a boolean — so it can serve the CLI's sender
   * validation without `terminal.show`'s writable-looking pane payload.
   */
  resolveTerminalIdentity(handle: string): RuntimeTerminalIdentity {
    return this.terminalIdentity.resolveTerminalIdentity(handle)
  }

  deliverPendingMessagesForHandle(
    ...args: Parameters<RuntimeMailboxControl['deliverPendingMessagesForHandle']>
  ) {
    return this.mailboxControl.deliverPendingMessagesForHandle(...args)
  }

  /** The structured idle edge: any journal movement is a chance to redrive parked mail. */
  notifyStructuredSessionJournalActivity(
    ...args: Parameters<RuntimeMailboxControl['notifyStructuredSessionJournalActivity']>
  ) {
    return this.mailboxControl.notifyStructuredSessionJournalActivity(...args)
  }

  /**
   * Every structured session's status change reaches here. At its idle edge, retry what is parked
   * on it and re-derive the mailboxes it owns, so mail it could not take earlier (mid-turn, closed)
   * is pointed again. Workers and chats alike: this is not per-dispatch.
   */
  onStructuredSessionStatusForMail(
    ...args: Parameters<RuntimeMailboxControl['onStructuredSessionStatusForMail']>
  ) {
    return this.mailboxControl.onStructuredSessionStatusForMail(...args)
  }

  /**
   * A chat tab left the screen. If that chat worked a Dispatch and has now ended, the Dispatch
   * settles as a terminal the operator closed does; a /clear moves the tab, so its successor keeps
   * the work.
   */
  onStructuredSessionTabHidden(
    ...args: Parameters<RuntimeMailboxControl['onStructuredSessionTabHidden']>
  ) {
    return this.mailboxControl.onStructuredSessionTabHidden(...args)
  }

  /** Settlement drops anything parked for the session; nothing will ever redrive it again. */
  forgetStructuredSessionMail(
    ...args: Parameters<RuntimeMailboxControl['forgetStructuredSessionMail']>
  ) {
    return this.mailboxControl.forgetStructuredSessionMail(...args)
  }

  /**
   * The session a mailbox must be nudged through, or null when a live PTY can take the bytes.
   *
   * All THREE address forms a structured session can own resolve here — its `dispatch:` address,
   * its `run:` mailbox when it coordinates, and its own bearer handle for peer mail outside a
   * dispatch. `run:` was the one that fell in a hole: the PTY lane declines because the owner is
   * structured, and this lane used to decline anything that was not `dispatch:`, so each half
   * believed the other owned it and a structured coordinator was never nudged.
   */
  protected resolveStructuredMailboxTarget(
    ...args: Parameters<RuntimeMailboxControl['resolveStructuredMailboxTarget']>
  ) {
    return this.mailboxControl.resolveStructuredMailboxTarget(...args)
  }

  /**
   * A Run's own mailbox, when the coordinator holding it is a structured session.
   *
   * A structured coordinator does NOT block in `check --wait` the way a PTY one does — it is a
   * chat session, and its turn ends — so the waiter that used to preempt pointer delivery is not
   * there to cover for the missing nudge. Session-scoped: a coordinator's run mailbox has no
   * dispatch, and needs none, since the ledger bucket is all a dispatch id ever supplied.
   */
  protected resolveStructuredCoordinatorMailboxTarget(
    ...args: Parameters<RuntimeMailboxControl['resolveStructuredCoordinatorMailboxTarget']>
  ) {
    return this.mailboxControl.resolveStructuredCoordinatorMailboxTarget(...args)
  }

  /**
   * Direct peer mail, addressed to the worker's own handle rather than to a dispatch.
   *
   * Nothing else can serve it: the PTY lane refuses a structured handle outright, so without this
   * the send stores durably, reports success, and no lane ever nudges the worker — the sender sees
   * success and the peer waiting on a reply hangs.
   *
   * The worker's ACTIVE dispatch is preferred when it has one, so peer and coordinator nudges share
   * one caller key and one set of retain rules. A worker BETWEEN dispatches is still nudged, under
   * a session-scoped caller key: the mail is durable, the session is live, and a dispatch
   * says nothing about whether delivery is safe — the idle gate and the writer lease do that.
   */
  protected resolveStructuredWorkerDirectMailboxTarget(
    ...args: Parameters<RuntimeMailboxControl['resolveStructuredWorkerDirectMailboxTarget']>
  ) {
    return this.mailboxControl.resolveStructuredWorkerDirectMailboxTarget(...args)
  }

  /** The session running a structured worker of this runtime: its `/clear` successor, if any. */

  protected scheduleRestoredMessageRepoints(
    ...args: Parameters<RuntimeMailboxControl['scheduleRestoredMessageRepoints']>
  ) {
    return this.mailboxControl.scheduleRestoredMessageRepoints(...args)
  }

  protected repointPendingMessagesForHandle(
    ...args: Parameters<RuntimeMailboxControl['repointPendingMessagesForHandle']>
  ) {
    return this.mailboxControl.repointPendingMessagesForHandle(...args)
  }

  protected deliverPendingMessagesForLeaf(
    ...args: Parameters<RuntimeMailboxControl['deliverPendingMessagesForLeaf']>
  ) {
    return this.mailboxControl.deliverPendingMessagesForLeaf(...args)
  }
}
