import { RuntimeTerminalIdentityOwner } from '../terminal/identity/terminal-identity-owner'
import type { TerminalIdentityHost } from '../terminal/identity/terminal-identity-host'
import { structuredWorkerTerminalRefusal } from '../structured-worker-terminal-refusal'
import { resolveStructuredWorkerAuthority } from '../structured-worker-authority'
import type { SessionLifecyclePorts } from './session-lifecycle-ports'

type SessionTerminalIdentityPorts = Pick<
  TerminalIdentityHost,
  | 'runtimeId'
  | 'wslDistroByPtyId'
  | 'titleObservationSequence'
  | 'setTitleObservationSequence'
  | 'assertGraphReady'
> & {
  getOrchestrationDb(): Parameters<typeof resolveStructuredWorkerAuthority>[1]
}

export function createSessionTerminalIdentityOwner(
  sessions: Pick<
    SessionLifecyclePorts,
    'state' | 'ptyRecords' | 'rejectWaitersForHandle' | 'bindRuntimeMethod'
  >,
  identity: SessionTerminalIdentityPorts
): RuntimeTerminalIdentityOwner {
  return new RuntimeTerminalIdentityOwner({
    ...identity,
    rendererGraphEpoch: () => sessions.state.rendererGraphEpoch,
    graphSequence: () => sessions.state.graphSequence,
    graphStatus: () => sessions.state.graphStatus,
    leaves: () => sessions.state.leaves,
    leavesByPtyId: () => sessions.state.leavesByPtyId,
    ptysById: () => sessions.ptyRecords(),
    rejectWaitersForHandle: (handle, code) =>
      sessions.bindRuntimeMethod(sessions.rejectWaitersForHandle())(handle, code),
    structuredTerminalRefusal: (handle) =>
      structuredWorkerTerminalRefusal(handle, identity.getOrchestrationDb()),
    isLiveStructuredWorker: (handle) =>
      Boolean(resolveStructuredWorkerAuthority(handle, identity.getOrchestrationDb()))
  })
}
