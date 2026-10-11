import type { RuntimeLeafRecord } from '../../runtime-terminal-state-records'
import type { TerminalHandleRecord } from '../../runtime-terminal-contracts'
import type { PtyIncarnationHandleRecord } from '../../orca-runtime-core'
import type { PtyIncarnationId } from '../../../../shared/pty-incarnation'
import type { TerminalIdentityHost } from './terminal-identity-host'
import {
  preAllocateHandleForPty,
  createPreAllocatedTerminalHandle,
  rememberPtyHandleReplacementFence,
  registerPreAllocatedHandleForPty,
  adoptControllerTerminalHandle,
  issueHandle
} from './terminal-handle-allocation'
import {
  bindPtyIncarnationHandle,
  invalidatePtyIncarnationHandle,
  clearPtyIncarnationHandles,
  reconcilePtyIncarnationHandles,
  adoptPreAllocatedHandle,
  issuePtyHandle,
  findHandleForPtyRecord,
  invalidateLeafHandle,
  adoptFirstPtyForLeafHandle,
  rememberDetachedPreAllocatedLeaves
} from './terminal-handle-bindings'
import {
  invalidateAllHandlesForPty,
  replaceSyntheticTerminalHandlesForRestoredPty,
  isTerminalHandleAdoptionBlocked
} from './terminal-handle-invalidation'
import {
  getLiveLeafForHandle,
  getLivePtyForHandle,
  assertLiveTerminalHandleTargetsPty,
  getPtyRecordForPaneKey,
  getPaneKeyForTerminalHandle,
  getTerminalWorktreeIdForHandle,
  resolveTerminalIdentity,
  leafExistsForPty,
  getLeavesForPty,
  getLeafKey
} from './terminal-handle-targets'
import {
  recordPtyWorktree,
  makeRuntimePaneKey,
  getOrCreatePtyWorktreeRecord,
  setPtyManagementTitleFromObservedTitle,
  nextTitleObservationSequence
} from './pty-worktree-record'

export class RuntimeTerminalIdentityOwner {
  readonly handles = new Map<string, TerminalHandleRecord>()
  readonly handleByLeafKey = new Map<string, string>()
  readonly handleByPtyId = new Map<string, string>()
  readonly handleByPtyIncarnation = new Map<string, PtyIncarnationHandleRecord>()
  readonly pendingPtyHandleReplacementFences = new Map<
    string,
    { incarnationId: PtyIncarnationId; staleHandles: Set<string>; pendingRegistration: boolean }
  >()
  readonly syntheticTerminalHandles = new Set<string>()
  readonly detachedPreAllocatedLeaves = new Map<string, RuntimeLeafRecord>()

  constructor(readonly host: TerminalIdentityHost) {}

  readonly preAllocateHandleForPty = preAllocateHandleForPty.bind(undefined, this)

  readonly createPreAllocatedTerminalHandle = createPreAllocatedTerminalHandle

  readonly rememberPtyHandleReplacementFence = rememberPtyHandleReplacementFence.bind(
    undefined,
    this
  )

  readonly registerPreAllocatedHandleForPty = registerPreAllocatedHandleForPty.bind(undefined, this)

  readonly adoptControllerTerminalHandle = adoptControllerTerminalHandle.bind(undefined, this)

  readonly issueHandle = issueHandle.bind(undefined, this)

  readonly bindPtyIncarnationHandle = bindPtyIncarnationHandle.bind(undefined, this)

  readonly invalidatePtyIncarnationHandle = invalidatePtyIncarnationHandle.bind(undefined, this)

  readonly clearPtyIncarnationHandles = clearPtyIncarnationHandles.bind(undefined, this)

  readonly reconcilePtyIncarnationHandles = reconcilePtyIncarnationHandles.bind(undefined, this)

  readonly adoptPreAllocatedHandle = adoptPreAllocatedHandle.bind(undefined, this)

  readonly issuePtyHandle = issuePtyHandle.bind(undefined, this)

  readonly findHandleForPtyRecord = findHandleForPtyRecord.bind(undefined, this)

  readonly invalidateLeafHandle = invalidateLeafHandle.bind(undefined, this)

  readonly adoptFirstPtyForLeafHandle = adoptFirstPtyForLeafHandle.bind(undefined, this)

  readonly rememberDetachedPreAllocatedLeaves = rememberDetachedPreAllocatedLeaves.bind(
    undefined,
    this
  )

  readonly invalidateAllHandlesForPty = invalidateAllHandlesForPty.bind(undefined, this)

  readonly replaceSyntheticTerminalHandlesForRestoredPty =
    replaceSyntheticTerminalHandlesForRestoredPty.bind(undefined, this)

  readonly isTerminalHandleAdoptionBlocked = isTerminalHandleAdoptionBlocked.bind(undefined, this)

  readonly getLiveLeafForHandle = getLiveLeafForHandle.bind(undefined, this)

  readonly getLivePtyForHandle = getLivePtyForHandle.bind(undefined, this)

  readonly assertLiveTerminalHandleTargetsPty = assertLiveTerminalHandleTargetsPty.bind(
    undefined,
    this
  )

  readonly getPtyRecordForPaneKey = getPtyRecordForPaneKey.bind(undefined, this)

  readonly getPaneKeyForTerminalHandle = getPaneKeyForTerminalHandle.bind(undefined, this)

  readonly getTerminalWorktreeIdForHandle = getTerminalWorktreeIdForHandle.bind(undefined, this)

  readonly resolveTerminalIdentity = resolveTerminalIdentity.bind(undefined, this)

  readonly leafExistsForPty = leafExistsForPty.bind(undefined, this)

  readonly getLeavesForPty = getLeavesForPty.bind(undefined, this)

  readonly getLeafKey = getLeafKey

  readonly recordPtyWorktree = recordPtyWorktree.bind(undefined, this)

  readonly makeRuntimePaneKey = makeRuntimePaneKey

  readonly getOrCreatePtyWorktreeRecord = getOrCreatePtyWorktreeRecord.bind(undefined, this)

  readonly setPtyManagementTitleFromObservedTitle = setPtyManagementTitleFromObservedTitle

  readonly nextTitleObservationSequence = nextTitleObservationSequence.bind(undefined, this)
}
