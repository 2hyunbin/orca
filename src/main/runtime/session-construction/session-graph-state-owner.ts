import { RuntimeGraphState } from '../session-graph/session-graph-state'
import type { SessionLifecyclePorts } from './session-lifecycle-ports'

import { SessionTabsInventoryPublication } from '../session-tabs/session-tabs-inventory-publication'

import {
  RUNTIME_GRAPH_RELOAD_TIMEOUT_MS,
  RuntimeGraphReloadLifecycle
} from '../runtime-graph-reload-lifecycle'

export abstract class RuntimeSessionGraphStateOwner {
  protected readonly runtimeGraphState = new RuntimeGraphState(
    () => this.detachedPreAllocatedLeaves
  )

  protected get rendererGraphEpoch(): RuntimeGraphState['rendererGraphEpoch'] {
    return this.runtimeGraphState.rendererGraphEpoch
  }

  protected set rendererGraphEpoch(value: RuntimeGraphState['rendererGraphEpoch']) {
    this.runtimeGraphState.rendererGraphEpoch = value
  }

  protected get graphStatus(): RuntimeGraphState['graphStatus'] {
    return this.runtimeGraphState.graphStatus
  }

  protected set graphStatus(value: RuntimeGraphState['graphStatus']) {
    this.runtimeGraphState.graphStatus = value
  }

  protected get authoritativeWindowId(): RuntimeGraphState['authoritativeWindowId'] {
    return this.runtimeGraphState.authoritativeWindowId
  }

  protected set authoritativeWindowId(value: RuntimeGraphState['authoritativeWindowId']) {
    this.runtimeGraphState.authoritativeWindowId = value
  }

  protected get headlessGraphFallbackAvailable(): RuntimeGraphState['headlessGraphFallbackAvailable'] {
    return this.runtimeGraphState.headlessGraphFallbackAvailable
  }

  protected set headlessGraphFallbackAvailable(
    value: RuntimeGraphState['headlessGraphFallbackAvailable']
  ) {
    this.runtimeGraphState.headlessGraphFallbackAvailable = value
  }

  protected get pendingHeadlessPromotionWindowId(): RuntimeGraphState['pendingHeadlessPromotionWindowId'] {
    return this.runtimeGraphState.pendingHeadlessPromotionWindowId
  }

  protected set pendingHeadlessPromotionWindowId(
    value: RuntimeGraphState['pendingHeadlessPromotionWindowId']
  ) {
    this.runtimeGraphState.pendingHeadlessPromotionWindowId = value
  }

  protected get rendererGeneration(): RuntimeGraphState['rendererGeneration'] {
    return this.runtimeGraphState.rendererGeneration
  }

  protected set rendererGeneration(value: RuntimeGraphState['rendererGeneration']) {
    this.runtimeGraphState.rendererGeneration = value
  }

  protected readonly graphReloadLifecycle = new RuntimeGraphReloadLifecycle({
    timeoutMs: RUNTIME_GRAPH_RELOAD_TIMEOUT_MS,
    onSettled: ({ revision, windowId, outcome, durationMs }) => {
      console.info(
        `[runtime-graph] reload revision=${revision} window=${windowId} outcome=${outcome} durationMs=${durationMs}`
      )
    },
    onTimeout: (_revision, windowId) => this.onSessionGraphReloadTimeout(windowId)
  })

  protected get tabs(): RuntimeGraphState['tabs'] {
    return this.runtimeGraphState.tabs
  }

  protected set tabs(value: RuntimeGraphState['tabs']) {
    this.runtimeGraphState.tabs = value
  }

  protected readonly sessionTabsInventoryPublication = new SessionTabsInventoryPublication({
    getGraphStatus: () => this.graphStatus,
    getRendererGraphEpoch: () => this.rendererGraphEpoch
  })

  // Why: counts authoritative graph statements so a PTY's recorded surface can be told apart
  // from one the graph has simply not published yet (pty-recorded-surface-topology.ts).
  protected get graphSequence(): RuntimeGraphState['graphSequence'] {
    return this.runtimeGraphState.graphSequence
  }

  protected set graphSequence(value: RuntimeGraphState['graphSequence']) {
    this.runtimeGraphState.graphSequence = value
  }

  protected get leaves(): RuntimeGraphState['leaves'] {
    return this.runtimeGraphState.leaves
  }

  protected set leaves(value: RuntimeGraphState['leaves']) {
    this.runtimeGraphState.leaves = value
  }

  // Why: PTY output is a per-keystroke hot path. Looking up affected leaves by
  // ptyId keeps active TUI redraws independent of the total open terminal count.
  protected get leavesByPtyId(): RuntimeGraphState['leavesByPtyId'] {
    return this.runtimeGraphState.leavesByPtyId
  }

  protected set leavesByPtyId(value: RuntimeGraphState['leavesByPtyId']) {
    this.runtimeGraphState.leavesByPtyId = value
  }

  protected abstract readonly detachedPreAllocatedLeaves: RuntimeGraphState['detachedPreAllocatedLeaves']

  protected get graphSyncCallbacks(): RuntimeGraphState['graphSyncCallbacks'] {
    return this.runtimeGraphState.graphSyncCallbacks
  }

  protected set graphSyncCallbacks(value: RuntimeGraphState['graphSyncCallbacks']) {
    this.runtimeGraphState.graphSyncCallbacks = value
  }

  protected onSessionGraphReloadTimeout(windowId: number): void {
    this.sessionPorts.bindRuntimeMethod(this.sessionPorts.handleGraphReloadTimeout())(windowId)
  }

  protected abstract readonly sessionPorts: Pick<
    SessionLifecyclePorts,
    'handleGraphReloadTimeout' | 'bindRuntimeMethod'
  >
}
