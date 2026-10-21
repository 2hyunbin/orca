import { app } from 'electron'
import { NOTIFICATIONS_HOST_AGENT_ALERTS_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { SourceAgentAlertEvent } from '../../runtime/source-agent-alert-event'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { createRuntimeEnvironmentMobileRelayHosts } from './runtime-environment-mobile-relay-hosts'
import { subscribeRuntimeEnvironment } from './runtime-environment-transport-routing'
import type { RemoteRuntimeSubscription } from '../../../shared/remote-runtime-client'
import { getRuntimeEnvironmentTransportGeneration } from './runtime-environment-transport-generation'

/** One source feed per verified server; the existing transport owns reconnect and unsubscribe. */
export function startRuntimeEnvironmentAgentAlerts(
  runtime: Pick<
    OrcaRuntimeService,
    'setNotificationSourceHost' | 'carrySourceAgentAlert' | 'getCarriedSourceDeliveries'
  >
): () => void {
  const hosts = createRuntimeEnvironmentMobileRelayHosts()
  const feeds = new Map<string, { fence: string; stop: () => void }>()
  const retire = (id: string): void => {
    feeds.get(id)?.stop()
    feeds.delete(id)
    runtime.setNotificationSourceHost(`runtime:${id}`, false)
  }
  const reconcile = (): void => {
    const { environments, statusByEnvironmentId } = hosts.list()
    for (const id of feeds.keys()) {
      if (!environments.some((host) => host.id === id)) {
        retire(id)
      }
    }
    for (const host of environments) {
      const status = statusByEnvironmentId.get(host.id)?.status
      // Loss of contact does not revoke the source's role.
      if (!status) {
        continue
      }
      const supported =
        status.capabilities?.includes(NOTIFICATIONS_HOST_AGENT_ALERTS_RUNTIME_CAPABILITY) === true
      const generation = getRuntimeEnvironmentTransportGeneration(host.id)
      const fence = `${host.pairingRevision}:${status.runtimeId}:${generation}`
      if (feeds.get(host.id)?.fence === fence) {
        continue
      }
      retire(host.id)
      if (!supported) {
        continue
      }
      const controller = new AbortController()
      let stream: RemoteRuntimeSubscription | null = null
      let sequence = 0
      let epoch: string | undefined
      let chain = Promise.resolve()
      const current = (): boolean =>
        !controller.signal.aborted &&
        feeds.get(host.id)?.fence === fence &&
        getRuntimeEnvironmentTransportGeneration(host.id) === generation
      const accept = (value: unknown): void => {
        if (!current()) {
          return
        }
        const parsed = SourceAgentAlertEvent.safeParse(value)
        if (!parsed.success) {
          return
        }
        const event = parsed.data
        runtime.carrySourceAgentAlert(`runtime:${host.id}`, event)
        if ('notificationSeq' in event) {
          sequence = Math.max(sequence, event.notificationSeq)
        }
      }
      feeds.set(host.id, {
        fence,
        stop: () => {
          controller.abort()
          stream?.close()
        }
      })
      runtime.setNotificationSourceHost(`runtime:${host.id}`, true)
      subscribeRuntimeEnvironment(
        app.getPath('userData'),
        host.id,
        'notifications.subscribe',
        { sourceEvents: true },
        15_000,
        {
          onEvent: (payload) => {
            if (
              !current() ||
              payload.type !== 'response' ||
              !payload.response.ok ||
              payload.response._meta.runtimeId !== status.runtimeId
            ) {
              return
            }
            const value = payload.response.result
            chain = chain
              .then(async () => {
                if (
                  value &&
                  typeof value === 'object' &&
                  'type' in value &&
                  value.type === 'ready'
                ) {
                  const nextEpoch =
                    'epoch' in value && typeof value.epoch === 'string' ? value.epoch : undefined
                  const delivered = runtime.getCarriedSourceDeliveries(`runtime:${host.id}`)
                  // The RPC accepts 256 receipts; reconcile the entire bounded ledger across batches.
                  for (let start = 0; start < Math.max(1, delivered.length); start += 256) {
                    const missed = await hosts.call(
                      { environmentId: host.id },
                      'notifications.getMissedSince',
                      {
                        lastSeenSeq: sequence,
                        epoch: epoch ?? nextEpoch,
                        sourceEvents: true,
                        deliveredPushes: delivered.slice(start, start + 256)
                      },
                      {
                        expected: {
                          pairingRevision: host.pairingRevision,
                          runtimeId: status.runtimeId
                        }
                      }
                    )
                    if (!current() || !missed.ok || missed._meta.runtimeId !== status.runtimeId) {
                      return
                    }
                    if (nextEpoch !== epoch) {
                      sequence = 0
                    }
                    epoch = nextEpoch
                    if (
                      missed.result &&
                      typeof missed.result === 'object' &&
                      'dismissedPushes' in missed.result &&
                      Array.isArray(missed.result.dismissedPushes)
                    ) {
                      for (const delivery of missed.result.dismissedPushes) {
                        accept({
                          type: 'dismiss',
                          notificationId: delivery.notificationId,
                          dismissedDelivery: delivery
                        })
                      }
                    }
                    if (
                      missed.result &&
                      typeof missed.result === 'object' &&
                      'notifications' in missed.result &&
                      Array.isArray(missed.result.notifications)
                    ) {
                      for (const event of missed.result.notifications) {
                        accept(event)
                      }
                    }
                  }
                } else {
                  accept(value)
                }
              })
              .catch(() => console.warn('[notifications] Source notification catch-up unavailable'))
          },
          onClose: () => {
            if (current()) {
              feeds.delete(host.id)
              controller.abort()
            }
          }
        },
        current,
        controller.signal
      ).then(
        (opened) => {
          stream = opened
          if (!current()) {
            opened.close()
          }
        },
        () => {
          if (current()) {
            feeds.delete(host.id)
            controller.abort()
          }
        }
      )
    }
  }
  const stopStatus = hosts.onStatusChanged(reconcile)
  const stopRetired = hosts.onEnvironmentRetired(retire)
  reconcile()
  return () => {
    stopStatus()
    stopRetired()
    for (const id of feeds.keys()) {
      retire(id)
    }
  }
}
