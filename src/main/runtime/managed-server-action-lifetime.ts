import { HostOperationLifetime } from './host-operation-lifetime'
import type { ManagedServerActions } from './managed-server-actions-registry'

export function trackManagedServerActions(actions: ManagedServerActions) {
  const lifetime = new HostOperationLifetime('The managed-server host is shutting down')
  const tracked: ManagedServerActions = {
    status: (selector) => lifetime.track(() => actions.status(selector)),
    update: (selector, force) => lifetime.track(() => actions.update(selector, force)),
    rollback: (selector) => lifetime.track(() => actions.rollback(selector)),
    recover: (selector, acceptChangedState) =>
      lifetime.track(() => actions.recover(selector, acceptChangedState)),
    stop: (selector) => lifetime.track(() => actions.stop(selector)),
    cancelStop: (selector) => lifetime.track(() => actions.cancelStop(selector)),
    forget: (selector) => lifetime.track(() => actions.forget(selector))
  }
  return { actions: tracked, drain: () => lifetime.drain() }
}
