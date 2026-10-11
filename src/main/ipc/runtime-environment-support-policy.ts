import { isOrchestrationMutation } from '../../shared/orchestration-rpc-contract'
import type { RuntimeOrchestrationEnvelope } from '../../shared/runtime-rpc-envelope'

export function shouldRouteCallBySupport(method: string): boolean {
  // Snapshot recovery must stay available while shared-control streams reconnect after a restart.
  return (
    method !== 'status.get' && method !== 'session.tabs.list' && method !== 'session.tabs.listAll'
  )
}

export function shouldRouteSubscriptionBySupport(method: string): boolean {
  if (method === 'browser.screencast' || method === 'terminal.multiplex') {
    return false
  }
  return (
    method === 'runtime.clientEvents.subscribe' ||
    method === 'session.tabs.subscribe' ||
    method === 'session.tabs.subscribeAll' ||
    method === 'accounts.subscribe' ||
    method === 'notifications.subscribe' ||
    method === 'files.watch'
  )
}

export function shouldUseSharedControlEnvelope(
  method: string,
  params: unknown,
  envelope: RuntimeOrchestrationEnvelope | undefined
): RuntimeOrchestrationEnvelope | undefined {
  return envelope && method.startsWith('orchestration.') && !isOrchestrationMutation(method, params)
    ? envelope
    : undefined
}
