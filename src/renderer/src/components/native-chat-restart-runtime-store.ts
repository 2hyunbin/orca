import {
  EMPTY,
  restartOfferOnTarget,
  type NativeChatRestartOffer,
  failedFrom,
  type HostOfferPayload,
  type HostOfferRead
} from './native-chat-restart-host-offer'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/structured-agent-session-status-feed'
import { markNativeChatLaunchResumeDecided } from './native-chat-launch-resume-decision'
import {
  announceRestartResults,
  restartContinuationHistory,
  type RestartContinuationOutcome
} from './native-chat-restart-action-notifications'
import {
  beginResumeRun,
  resumeRunInFlight,
  resumeRunPendingIds,
  type ResumeRun,
  type ResumeRunStarter
} from './native-chat-resume-run'
import { createUnsentResumes } from './native-chat-resume-unsent-requests'
import * as dialog from './native-chat-resume-on-restart-dialog'
import { createOfferedChatWatch } from './native-chat-resume-offered-chat-watch'
import { createRemoteRestartOfferLifecycle } from './native-chat-remote-restart-offer'
import { watchResumeRunStatus } from './native-chat-resume-run-status-watch'

/**
 * Which interrupted chats the host is still offering to resume, and every action that moves that.
 *
 * The offer is the HOST's answer, shared by the dialog and the status bar rather than held by
 * whichever rendered first. Opening a chat is intentionally read-only; only an explicit action
 * changes the durable offer.
 *
 * What stays on this side is the user's own facts: the snooze, and the preference that decides
 * whether the launch asks at all.
 */

export function createNativeChatRestartStore(target: RuntimeClientTarget) {
  const key = target.kind === 'local' ? 'local' : target.environmentId
  const requestNativeChatResumeOnRestartDialog = () =>
    dialog.requestNativeChatResumeOnRestartDialog(key)
  const consumeNativeChatResumeOnRestartDialogRequest = () =>
    dialog.consumeNativeChatResumeOnRestartDialogRequest(key)
  const getNativeChatResumeOnRestartDialogRequest = () =>
    dialog.getNativeChatResumeOnRestartDialogRequest(key)
  const subscribeNativeChatResumeOnRestartDialog = dialog.subscribeNativeChatResumeOnRestartDialog
  const { forgetUnsentResumes, markUnsentResumes, withUnsentResumes } = createUnsentResumes()
  let offer: NativeChatRestartOffer = EMPTY
  /** Continue and dismiss calls, begun and settled. Each ends by publishing the host's answer, which
   *  a re-read that raced it must neither pre-empt nor undo. */
  let actionsBegun = 0
  let actionsSettled = 0
  /** Memory-only history: retires after viewing and closing its finished summary, or on replacement. */
  let run: ResumeRun | null = null
  let releaseRunStatus: (() => void) | undefined
  let resuming: readonly string[] = resumeRunPendingIds(null)
  const listeners = new Set<() => void>()

  function emit(): void {
    for (const listener of listeners) {
      listener()
    }
  }

  /** The snapshot object is replaced HERE and nowhere else — never during a render — so every
   *  `useSyncExternalStore` reader sees the same reference until a host answer or a user action
   *  actually moves the offer. */
  function publish(next: NativeChatRestartOffer): void {
    offer = next
    offeredChatWatch.sync()
    emit()
  }

  /** A confirmed host answer. One with nothing left also retires any open request for the dialog,
   *  unless it is showing a run; a failed read only hides rows, so it keeps the request. */
  function publishAnswer(answer: NativeChatRestartOffer): void {
    const next = withUnsentResumes(restartOfferOnTarget(answer, target))
    publish(next)
    if (next.candidates.length === 0 && next.failed.length === 0 && run === null) {
      consumeNativeChatResumeOnRestartDialogRequest()
    }
  }

  function setRun(next: ResumeRun | null): void {
    run = next
    const pending = resumeRunPendingIds(next)
    // Same ids, same array, so readers of `resuming` re-render only when it changes.
    resuming = pending.join('\0') === resuming.join('\0') ? resuming : pending
    emit()
  }

  // Re-reads once an offered or failed chat shows new activity. Skipped while an action is in
  // flight: that action ends by publishing the host's answer, which a racing re-read must not undo.
  const offeredChatWatch = createOfferedChatWatch({
    feed: () => getStructuredAgentSessionStatusFeed(target),
    offeredIds: () =>
      new Set([...offer.candidates, ...offer.failed].map((entry) => entry.sessionId)),
    listedAt: () => offer.listedAt,
    refresh: () => {
      if (actionsBegun === actionsSettled) {
        const issued = actionsBegun
        void readNativeChatRestartOffer(() => actionsBegun === issued)
      }
    }
  })

  const getNativeChatRestartOffer = (): NativeChatRestartOffer => offer

  function getNativeChatRestartResuming(): readonly string[] {
    return resuming
  }

  const getNativeChatRestartRun = (): ResumeRun | null => run

  /** A finished summary must be shown before closing can retire it. */
  function markFinishedNativeChatRestartRunShown(shown: ResumeRun): void {
    if (run === shown && !shown.inFlight && !shown.finishedViewShown) {
      setRun({ ...shown, finishedViewShown: true })
    }
  }

  function releaseFinishedNativeChatRestartRun(): void {
    if (run?.finishedViewShown && !resumeRunInFlight(run)) {
      setRun(null)
    }
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  /**
   * Re-reads the host's answer.
   *
   * Called before the dialog is reopened, so a count can never name a chat the host would now refuse.
   */
  async function readNativeChatRestartOffer(current = () => true): Promise<HostOfferRead> {
    try {
      const offered = await callStructuredAgentSession<HostOfferPayload>(
        target,
        'agentSession.restartResumable'
      )
      if (!Array.isArray(offered.sessions)) {
        throw new Error('agent_session_restart_offer_invalid')
      }
      const failed = failedFrom(offered)
      if (current()) {
        publishAnswer({ candidates: offered.sessions, failed, listedAt: Date.now() })
      }
      return { candidates: offered.sessions, failed, available: true }
    } catch {
      // A failed read is not an answer. Hide the last snapshot so a modal can never present a
      // candidate the host has not confirmed; the durable record remains and a later refresh can
      // restore it.
      if (current()) {
        publish({ ...EMPTY, listedAt: Date.now() })
        if (target.kind !== 'local') {
          consumeNativeChatResumeOnRestartDialogRequest()
        }
      }
      return { candidates: [], failed: [], available: false }
    }
  }

  async function refreshNativeChatRestartOffer(): Promise<void> {
    await readNativeChatRestartOffer()
  }

  /** The status bar entry and the toast's action: re-read, then open only over rows, since the dialog
   *  draws nothing without them. Opening a chat from it is read-only and keeps the offer. */
  async function reopenNativeChatRestartOffer(): Promise<void> {
    // Mid-resume the host's answer is already on its way; a re-read racing it could undo it.
    if (resuming.length === 0) {
      await readNativeChatRestartOffer()
    }
    if (run !== null || offer.candidates.length > 0 || offer.failed.length > 0) {
      requestNativeChatResumeOnRestartDialog()
    }
  }

  /** One host action owns the selection; its status feed reports each chat before the reply. */
  async function continueNativeChatRestartOffer(
    sessionIds: readonly string[],
    startedBy: ResumeRunStarter = 'user'
  ): Promise<void> {
    const requested = [...new Set(sessionIds)]
    if (requested.length === 0) {
      return
    }
    actionsBegun += 1
    forgetUnsentResumes(requested)
    const rows = new Map([...offer.candidates, ...offer.failed].map((row) => [row.sessionId, row]))
    let actionRun = beginResumeRun(
      requested.flatMap((sessionId) => rows.get(sessionId) ?? []),
      Date.now(),
      startedBy
    )
    setRun(actionRun)
    releaseRunStatus?.()
    const release = watchResumeRunStatus(
      () => (run === actionRun ? actionRun : null),
      (next) => {
        actionRun = next
        setRun(next)
      },
      target
    )
    releaseRunStatus = release
    if (target.kind === 'local') {
      markNativeChatLaunchResumeDecided()
    }
    let outcome: Parameters<typeof announceRestartResults>
    let continued: readonly RestartContinuationOutcome[] | undefined
    let skipped = new Set<string>()
    try {
      const result = await callStructuredAgentSession<
        HostOfferPayload & { continued?: RestartContinuationOutcome[]; skipped?: string[] }
      >(target, 'agentSession.restartContinue', { sessionIds: requested })
      const listed = Array.isArray(result.failed) ? failedFrom(result) : undefined
      if (Array.isArray(result.sessions)) {
        publishAnswer({ candidates: result.sessions, failed: listed ?? [], listedAt: Date.now() })
      } else {
        await refreshNativeChatRestartOffer()
      }
      skipped = new Set(result.skipped)
      const actedOn = requested.filter((sessionId) => !skipped.has(sessionId))
      continued = restartContinuationHistory(actedOn, result.continued, listed)
      outcome = [actedOn, continued, listed, reopenNativeChatRestartOffer]
    } catch (error) {
      console.warn('[native-chat-resume] resume request failed before reaching the chats', error)
      markUnsentResumes(requested, Date.now())
      const read = await readNativeChatRestartOffer()
      outcome = [
        requested,
        [],
        read.available ? offer.failed : undefined,
        reopenNativeChatRestartOffer
      ]
    } finally {
      release()
      if (releaseRunStatus === release) {
        releaseRunStatus = undefined
      }
      actionsSettled += 1
      // Publish the offer first: reopening must never expose the old selection as actionable.
      if (run === actionRun) {
        setRun({
          ...actionRun,
          entries: actionRun.entries.filter((entry) => !skipped.has(entry.candidate.sessionId)),
          inFlight: false,
          continued
        })
      }
    }
    announceRestartResults(...outcome)
  }

  /**
   * Turning the offer down for good, which explicitly deletes the pending durable records.
   *
   * A failed write or unreachable host leaves the durable record untouched. The re-read puts it back
   * in the status bar; if that read fails too, the entry stays hidden until the next launch reads it.
   */
  async function dismissNativeChatRestartOffer(sessionIds?: readonly string[]): Promise<void> {
    if (target.kind !== 'local') {
      consumeNativeChatResumeOnRestartDialogRequest()
      releaseFinishedNativeChatRestartRun()
      return
    }
    actionsBegun += 1
    try {
      const result = await callStructuredAgentSession<HostOfferPayload>(
        target,
        'agentSession.restartResumableDismiss',
        // Named only for rows the dialog lists as failed: the host's own failures, or chats this side
        // marked after a lost resume request, which the host still lists as offers. The host is this
        // build, and it forgets named records of any state.
        sessionIds ? { sessionIds: [...sessionIds] } : {}
      )
      // Only a dismissal the host took ends the mark; a failed one leaves the chat shown as failed.
      forgetUnsentResumes(sessionIds)
      if (Array.isArray(result.sessions)) {
        publishAnswer({
          candidates: result.sessions,
          failed: failedFrom(result),
          listedAt: Date.now()
        })
      } else {
        await refreshNativeChatRestartOffer()
      }
    } catch {
      await refreshNativeChatRestartOffer()
    } finally {
      actionsSettled += 1
    }
  }

  /** @internal - tests need a clean module between cases. */
  function _resetNativeChatRestartOffer(): void {
    releaseRunStatus?.()
    releaseRunStatus = undefined
    offeredChatWatch.release()
    offer = EMPTY
    forgetUnsentResumes(undefined)
    run = null
    resuming = resumeRunPendingIds(null)
    actionsBegun = 0
    actionsSettled = 0
    listeners.clear()
  }

  return {
    target,
    getNativeChatRestartOffer,
    getNativeChatRestartResuming,
    getNativeChatRestartRun,
    markFinishedNativeChatRestartRunShown,
    releaseFinishedNativeChatRestartRun,
    refreshNativeChatRestartOffer,
    reopenNativeChatRestartOffer,
    continueNativeChatRestartOffer,
    dismissNativeChatRestartOffer,
    _resetNativeChatRestartOffer,
    consumeNativeChatResumeOnRestartDialogRequest,
    getNativeChatResumeOnRestartDialogRequest,
    subscribeNativeChatResumeOnRestartDialog,
    subscribe,
    readNativeChatRestartOffer,
    ...createRemoteRestartOfferLifecycle({
      read: readNativeChatRestartOffer,
      requestDialog: requestNativeChatResumeOnRestartDialog,
      currentAction: () => actionsBegun
    })
  }
}
