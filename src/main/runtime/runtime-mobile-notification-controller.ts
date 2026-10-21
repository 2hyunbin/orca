import type { SourceAgentAlertEvent } from './source-agent-alert-event'
import { reserveNotificationCooldown } from '../../shared/notification-burst-cooldown'
import { buildAgentNotificationId } from '../../shared/agent-notification-id'
import type { AgentStatusState } from '../../shared/agent-status-types'
import {
  agentSessionAttentionSubjectPrefix,
  attentionOriginWasRead,
  type StructuredAttentionOrigin,
  type StructuredAttentionRead,
  type StructuredAttentionState
} from '../../shared/agent-session-attention'
import type {
  MobilePushTestResult,
  MobilePushRegisterInput,
  MobilePushRegisterResult
} from '../../shared/mobile-push-contract'
import { MobileNotificationReplayBuffer } from './mobile-notification-replay'
import { notifyRuntimeListeners } from './runtime-async-boundaries'
import { getRuntimeDesktopSurface } from './runtime-desktop-surface'
import { MobileNotificationDismissalStore } from './mobile-notification-dismissal-store'
import type { DeliveredNotificationIdentity } from '../../shared/mobile-notification-identity'

export type MobileNotificationDispatchEvent = {
  type: 'notification'
  legacySocketAllowed?: boolean
  desktopAllowed?: boolean
  desktopAway?: boolean
  emittedAt?: number
  source: 'agent-task-complete' | 'terminal-bell' | 'test' | 'plugin'
  title: string
  body: string
  worktreeId?: string
  /** See `NotificationDispatchRequest.executionHost`; old phones ignore it and open the desktop's. */
  executionHost?: `runtime:${string}`
  notificationId?: string
  notificationSeq?: number
  notificationEpoch?: string
  // Why: background push must tell "needs input" from "finished" without re-deriving
  // it from the title. Optional and additive — old clients ignore it.
  agentState?: AgentStatusState
  /** See `NotificationDispatchRequest.attentionKey`: cooldowns key on it instead of the workspace. */
  attentionKey?: string
  structuredOrigin?: StructuredAttentionOrigin
  /** See `NotificationDispatchRequest.executionHostAnnounces`. */
  executionHostAnnounces?: boolean
  /** This host's main announced it from the hook rows, for phones that take host agent alerts. */
  hostAgentAlert?: boolean
  sourcePlan?: { kind: 'terminal' | 'structured'; direct: readonly string[]; carrier?: boolean }
  sourceOwned?: boolean
}

export type MobileNotificationDismissEvent = {
  type: 'dismiss'
  notificationId: string
  notificationSeq?: number
  notificationEpoch?: string
  sourceOnly?: boolean
  dismissedDelivery?: DeliveredNotificationIdentity
}

export type MobileNotificationEvent =
  | MobileNotificationDispatchEvent
  | MobileNotificationDismissEvent

/** The desktop push service, once it exists; absent on hosts that never started one. */
export type MobilePushRegistrar = {
  planAgentAlert?(event: Pick<MobileNotificationDispatchEvent, 'hostAgentAlert'>): string[]
  test(deviceId: string): Promise<MobilePushTestResult>
  register(input: MobilePushRegisterInput): Promise<MobilePushRegisterResult>
  unregister(deviceId: string): Promise<{ unregistered: boolean }>
}

export class RuntimeMobileNotificationController {
  private readonly listeners = new Set<(event: MobileNotificationEvent) => void>()
  readonly sourceHosts = new Set<string>()
  private readonly legacyCooldown = new Map<string, number>()
  private readonly replay = new MobileNotificationReplayBuffer()
  private pushRegistrar: MobilePushRegistrar | null = null
  private dismissalStore: MobileNotificationDismissalStore | null = null

  configureDismissalStore(userDataPath: string): void {
    this.dismissalStore = new MobileNotificationDismissalStore(userDataPath)
  }

  /** Waits for the pending dismissal write without closing the store. */
  flushDismissals(): Promise<void> {
    return this.dismissalStore?.flush() ?? Promise.resolve()
  }

  closeDismissals(): Promise<void> {
    return this.dismissalStore?.close() ?? Promise.resolve()
  }

  reconcileDismissedPushes(
    delivered: readonly DeliveredNotificationIdentity[]
  ): DeliveredNotificationIdentity[] {
    return this.dismissalStore?.reconcile(delivered) ?? []
  }

  setPushRegistrar(registrar: MobilePushRegistrar | null): void {
    this.pushRegistrar = registrar
  }

  async registerPushDevice(input: MobilePushRegisterInput): Promise<MobilePushRegisterResult> {
    return (
      (await this.pushRegistrar?.register(input)) ?? {
        registered: false,
        reason: 'gateway_unreachable'
      }
    )
  }

  async testPushDevice(deviceId: string): Promise<MobilePushTestResult> {
    return (await this.pushRegistrar?.test(deviceId)) ?? { accepted: false, reason: 'unavailable' }
  }

  async unregisterPushDevice(deviceId: string): Promise<{ unregistered: boolean }> {
    return (await this.pushRegistrar?.unregister(deviceId)) ?? { unregistered: false }
  }

  onDispatched(listener: (event: MobileNotificationEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getListenerCount(): number {
    return this.listeners.size
  }

  dispatch(event: MobileNotificationEvent): void {
    if (event.type === 'notification') {
      if (
        !event.sourcePlan &&
        (event.hostAgentAlert || event.structuredOrigin) &&
        !event.executionHost
      ) {
        event = {
          ...event,
          sourcePlan: Object.freeze({
            kind: event.hostAgentAlert ? 'terminal' : 'structured',
            direct: Object.freeze(this.pushRegistrar?.planAgentAlert?.(event) ?? [])
          })
        }
      }
      if (event.executionHostAnnounces && event.executionHost) {
        event = { ...event, sourceOwned: this.sourceHosts.has(event.executionHost) }
      }
      // Decide once before recording so reconnect and buffer eviction cannot reset cooldown.
      const legacySocketAllowed =
        !event.hostAgentAlert &&
        !event.sourcePlan?.carrier &&
        event.desktopAllowed !== false &&
        (event.emittedAt === undefined ||
          reserveNotificationCooldown(
            this.legacyCooldown,
            event.attentionKey ?? event.worktreeId ?? 'global',
            event.emittedAt
          ))
      event = {
        ...event,
        legacySocketAllowed,
        desktopAway: getRuntimeDesktopSurface().isAwayForMobileNotifications?.()
      }
    }
    const seq = this.replay.record(event)
    try {
      this.dismissalStore?.record({
        ...event,
        notificationSeq: seq,
        notificationEpoch: this.replay.epoch
      })
    } catch {
      console.warn('[notifications] Could not persist dismissal recovery state')
    }
    notifyRuntimeListeners(
      this.listeners,
      (listener) =>
        listener({
          ...event,
          notificationSeq: seq,
          notificationEpoch: this.replay.epoch
        }),
      'mobile-notification'
    )
  }

  getMissedSince(lastSeenSeq: number, epoch?: string, sourceEvents = false) {
    return this.replay
      .getMissedSince(lastSeenSeq, epoch)
      .filter(
        (event) =>
          !sourceEvents ||
          event.type !== 'notification' ||
          !event.notificationId ||
          this.reconcileDismissedPushes([{ ...event, notificationId: event.notificationId }])
            .length === 0
      )
  }

  setSourceHost(executionHost: string, supported: boolean): void {
    if (supported) {
      this.sourceHosts.add(executionHost)
    } else {
      this.sourceHosts.delete(executionHost)
    }
  }

  carriedSourceDeliveries(executionHost: `runtime:${string}`): DeliveredNotificationIdentity[] {
    const prefix = `carry:${encodeURIComponent(executionHost)}:`
    return (this.dismissalStore?.liveDeliveries(prefix) ?? []).flatMap((delivery) => {
      const [id, epoch, seq] = delivery.notificationId.slice(prefix.length).split(':')
      return id && epoch && seq
        ? [
            {
              notificationId: decodeURIComponent(id),
              notificationEpoch: decodeURIComponent(epoch),
              notificationSeq: Number(seq)
            }
          ]
        : []
    })
  }

  carrySourceAlert(executionHost: `runtime:${string}`, event: SourceAgentAlertEvent): void {
    const source = event.type === 'dismiss' ? event.dismissedDelivery : event
    const notificationId = [
      'carry',
      encodeURIComponent(executionHost),
      encodeURIComponent(source.notificationId),
      encodeURIComponent(source.notificationEpoch),
      source.notificationSeq
    ].join(':')
    if (event.type === 'dismiss') {
      for (const delivery of this.dismissalStore?.liveDeliveries(notificationId) ?? []) {
        if (delivery.notificationId === notificationId) {
          this.retireDelivery(delivery)
        }
      }
    } else if (!this.dismissalStore?.hasNotification(notificationId)) {
      this.dispatch({
        ...event,
        notificationId,
        executionHost,
        sourcePlan: { ...event.sourcePlan, carrier: true }
      })
    }
  }

  getEpoch(): string {
    return this.replay.epoch
  }

  dismiss(notificationId: string): void {
    this.dispatch({ type: 'dismiss', notificationId })
  }

  private retireDelivery(delivery: DeliveredNotificationIdentity): void {
    this.dispatch({
      type: 'dismiss',
      notificationId: delivery.notificationId,
      ...(delivery.notificationId.startsWith('agent:') ||
      delivery.notificationId.startsWith('carry:')
        ? { sourceOnly: true }
        : {}),
      dismissedDelivery: {
        notificationId: delivery.notificationId,
        notificationEpoch: delivery.notificationEpoch,
        notificationSeq: delivery.notificationSeq
      }
    })
  }

  retireStructuredAttention(read: StructuredAttentionRead): void {
    for (const delivery of this.dismissalStore?.liveDeliveries() ?? []) {
      if (attentionOriginWasRead(delivery.structuredOrigin, read)) {
        this.retireDelivery(delivery)
      }
    }
  }

  retireTerminalAttention(worktreeId: string, paneKey: string, before: number): void {
    const prefix = buildAgentNotificationId({ worktreeId, paneKey, stateStartedAt: 0 })?.slice(
      0,
      -1
    )
    if (!prefix) {
      return
    }
    for (const delivery of this.dismissalStore?.liveDeliveries(prefix) ?? []) {
      // A background completion belongs to the current working run until a newer boundary arrives.
      if (Number(delivery.notificationId.slice(prefix.length)) < before) {
        this.retireDelivery(delivery)
      }
    }
  }

  reconcileStructuredPromptAttention(state: StructuredAttentionState): void {
    const prefix = agentSessionAttentionSubjectPrefix(state.scope, state.sessionId)
    const pending = new Set(state.pendingPromptIds)
    for (const delivery of this.dismissalStore?.liveDeliveries(prefix) ?? []) {
      const cause = delivery.structuredOrigin?.cause
      if (cause?.kind === 'prompt' && !pending.has(cause.promptId)) {
        this.retireDelivery(delivery)
      }
    }
  }

  async dispatchPlugin(input: {
    pluginId: string
    title: string
    body?: string
  }): Promise<{ delivered: boolean }> {
    const title = `${input.pluginId}: ${input.title}`
    const body = input.body ?? ''
    let delivered = false
    try {
      delivered = getRuntimeDesktopSurface().showNotification({ title, body })
    } catch {
      // Headless runtimes still relay the notification to mobile clients.
    }
    this.dispatch({ type: 'notification', source: 'plugin', title, body })
    return { delivered }
  }
}
