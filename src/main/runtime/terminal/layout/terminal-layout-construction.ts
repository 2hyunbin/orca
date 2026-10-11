import { mobileTookFloor, updateMobileViewport } from './mobile-terminal-activity'
import {
  reclaimTerminalForDesktop,
  cancelPendingDriverMutations,
  releaseDesktopTakeBack,
  getAutoRestoreFitMs,
  cancelAllPendingFitRestoreTimers,
  getMobileAutoRestoreFitMs,
  setMobileAutoRestoreFitMs
} from './terminal-desktop-reclaim'
import {
  pickMostRecentActor,
  pickEarliestRestoreTarget,
  getLayout,
  isFreshSubscribe,
  resolveDesktopRestoreTarget,
  coalescesWith,
  enqueueLayout,
  runLayoutSlot
} from './terminal-layout-queue'
import {
  applyLayout,
  setMobileDisplayMode,
  getMobileDisplayMode,
  isMobileSubscriberActive,
  updateMobileSubscriberViewport
} from './terminal-layout-application'
import { handleMobileSubscribe, handleMobileSubscribeInternal } from './mobile-terminal-subscribe'
import { handleMobileUnsubscribe } from './mobile-terminal-unsubscribe'
import {
  applyMobileDisplayMode,
  onExternalPtyResize,
  recordRendererGeometry,
  getLastRendererSize,
  refreshRendererGeometry,
  isResizeSuppressed,
  suppressResizesForMs
} from './terminal-display-mode'
import { onClientDisconnected } from './terminal-client-disconnect'
import {
  registerRemoteTerminalViewSubscriber,
  isKnownUnattachedLocalDaemonPty,
  reconcileSubscriberDrivenProviderAttach,
  registerRawTerminalViewSubscriber,
  hasRawTerminalViewSubscriber,
  hasRemoteTerminalViewSubscriber,
  isMobileTerminalQueryReplyAuthority,
  subscribeToFitOverrideChanges,
  subscribeToDriverChanges,
  notifyFitOverrideListeners
} from './terminal-view-presence'
import { subscribeToTerminalResize, notifyTerminalResize } from './terminal-resize-listeners'
import {
  getDriver,
  setDriver,
  isPtyResizeDrivenRemotely,
  isRemoteDesktopResizeDriven,
  isRemoteDesktopViewerOwner,
  getRemoteDesktopFitHold,
  recordRemoteDesktopHostReclaimTarget,
  applyRemoteDesktopLayout,
  updateRemoteDesktopViewer,
  claimRemoteDesktopViewer,
  claimRemoteDesktopHost,
  noteRemoteDesktopHostInput,
  unregisterRemoteDesktopViewer,
  unregisterRemoteDesktopViewers,
  refreshRemoteDesktopViewer,
  updateDesktopViewport,
  markMobileActor,
  beginMobileInputFloor
} from './terminal-input-floor'
import {
  resizeForClient,
  getTerminalFitOverride,
  getAllTerminalFitOverrides,
  getAllTerminalDrivers
} from './terminal-fit-overrides'
import {
  clearPtyMobilePresence,
  retirePtyLayoutQueue,
  releaseExitedPtyFitOverride,
  clearExitedPtyFloors,
  markTerminalSpawnPublished,
  resetTerminalViewGeneration,
  notifyRemoteTerminalViewPresenceChanged
} from './terminal-layout-lifecycle'
import type { TerminalLayoutHost, TerminalLayoutContext } from './terminal-layout-context'
import type { TerminalLayoutCommands } from './terminal-layout-commands'
import type { TerminalLayoutState } from './terminal-layout-state'
import { RuntimeTerminalDriverController } from '../../runtime-terminal-driver-controller'
import { RemoteDesktopTerminalFloor } from '../../remote-desktop-terminal-floor'
import { RuntimeTerminalViewSubscribers } from '../../runtime-terminal-view-subscribers'

export function createTerminalLayoutCommands(state: TerminalLayoutState, host: TerminalLayoutHost) {
  const commands: TerminalLayoutCommands = {
    mobileTookFloor: (...args) => mobileTookFloor(context, ...args),
    updateMobileViewport: (...args) => updateMobileViewport(context, ...args),
    reclaimTerminalForDesktop: (...args) => reclaimTerminalForDesktop(context, ...args),
    cancelPendingDriverMutations: (...args) => cancelPendingDriverMutations(context, ...args),
    releaseDesktopTakeBack: (...args) => releaseDesktopTakeBack(context, ...args),
    getAutoRestoreFitMs: (...args) => getAutoRestoreFitMs(context, ...args),
    cancelAllPendingFitRestoreTimers: (...args) =>
      cancelAllPendingFitRestoreTimers(context, ...args),
    getMobileAutoRestoreFitMs: (...args) => getMobileAutoRestoreFitMs(context, ...args),
    setMobileAutoRestoreFitMs: (...args) => setMobileAutoRestoreFitMs(context, ...args),
    pickMostRecentActor: (...args) => pickMostRecentActor(...args),
    pickEarliestRestoreTarget: (...args) => pickEarliestRestoreTarget(...args),
    getLayout: (...args) => getLayout(context, ...args),
    isFreshSubscribe: (...args) => isFreshSubscribe(context, ...args),
    resolveDesktopRestoreTarget: (...args) => resolveDesktopRestoreTarget(context, ...args),
    coalescesWith: (...args) => coalescesWith(...args),
    enqueueLayout: (...args) => enqueueLayout(context, ...args),
    runLayoutSlot: (...args) => runLayoutSlot(context, ...args),
    applyLayout: (...args) => applyLayout(context, ...args),
    setMobileDisplayMode: (...args) => setMobileDisplayMode(context, ...args),
    getMobileDisplayMode: (...args) => getMobileDisplayMode(context, ...args),
    isMobileSubscriberActive: (...args) => isMobileSubscriberActive(context, ...args),
    updateMobileSubscriberViewport: (...args) => updateMobileSubscriberViewport(context, ...args),
    handleMobileSubscribe: (...args) => handleMobileSubscribe(context, ...args),
    handleMobileSubscribeInternal: (...args) => handleMobileSubscribeInternal(context, ...args),
    handleMobileUnsubscribe: (...args) => handleMobileUnsubscribe(context, ...args),
    applyMobileDisplayMode: (...args) => applyMobileDisplayMode(context, ...args),
    onExternalPtyResize: (...args) => onExternalPtyResize(context, ...args),
    recordRendererGeometry: (...args) => recordRendererGeometry(context, ...args),
    getLastRendererSize: (...args) => getLastRendererSize(context, ...args),
    refreshRendererGeometry: (...args) => refreshRendererGeometry(context, ...args),
    isResizeSuppressed: (...args) => isResizeSuppressed(context, ...args),
    suppressResizesForMs: (...args) => suppressResizesForMs(context, ...args),
    onClientDisconnected: (...args) => onClientDisconnected(context, ...args),
    registerRemoteTerminalViewSubscriber: (...args) =>
      registerRemoteTerminalViewSubscriber(context, ...args),
    isKnownUnattachedLocalDaemonPty: (...args) => isKnownUnattachedLocalDaemonPty(context, ...args),
    reconcileSubscriberDrivenProviderAttach: (...args) =>
      reconcileSubscriberDrivenProviderAttach(context, ...args),
    registerRawTerminalViewSubscriber: (...args) =>
      registerRawTerminalViewSubscriber(context, ...args),
    hasRawTerminalViewSubscriber: (...args) => hasRawTerminalViewSubscriber(context, ...args),
    hasRemoteTerminalViewSubscriber: (...args) => hasRemoteTerminalViewSubscriber(context, ...args),
    isMobileTerminalQueryReplyAuthority: (...args) =>
      isMobileTerminalQueryReplyAuthority(context, ...args),
    subscribeToFitOverrideChanges: (...args) => subscribeToFitOverrideChanges(context, ...args),
    subscribeToDriverChanges: (...args) => subscribeToDriverChanges(context, ...args),
    notifyFitOverrideListeners: (...args) => notifyFitOverrideListeners(context, ...args),
    subscribeToTerminalResize: (...args) => subscribeToTerminalResize(context, ...args),
    notifyTerminalResize: (...args) => notifyTerminalResize(context, ...args),
    getDriver: (...args) => getDriver(context, ...args),
    setDriver: (...args) => setDriver(context, ...args),
    isPtyResizeDrivenRemotely: (...args) => isPtyResizeDrivenRemotely(context, ...args),
    isRemoteDesktopResizeDriven: (...args) => isRemoteDesktopResizeDriven(context, ...args),
    isRemoteDesktopViewerOwner: (...args) => isRemoteDesktopViewerOwner(context, ...args),
    getRemoteDesktopFitHold: (...args) => getRemoteDesktopFitHold(context, ...args),
    recordRemoteDesktopHostReclaimTarget: (...args) =>
      recordRemoteDesktopHostReclaimTarget(context, ...args),
    applyRemoteDesktopLayout: (...args) => applyRemoteDesktopLayout(context, ...args),
    updateRemoteDesktopViewer: (...args) => updateRemoteDesktopViewer(context, ...args),
    claimRemoteDesktopViewer: (...args) => claimRemoteDesktopViewer(context, ...args),
    claimRemoteDesktopHost: (...args) => claimRemoteDesktopHost(context, ...args),
    noteRemoteDesktopHostInput: (...args) => noteRemoteDesktopHostInput(context, ...args),
    unregisterRemoteDesktopViewer: (...args) => unregisterRemoteDesktopViewer(context, ...args),
    unregisterRemoteDesktopViewers: (...args) => unregisterRemoteDesktopViewers(context, ...args),
    refreshRemoteDesktopViewer: (...args) => refreshRemoteDesktopViewer(context, ...args),
    updateDesktopViewport: (...args) => updateDesktopViewport(context, ...args),
    markMobileActor: (...args) => markMobileActor(context, ...args),
    beginMobileInputFloor: (...args) => beginMobileInputFloor(context, ...args),
    resizeForClient: (...args) => resizeForClient(context, ...args),
    getTerminalFitOverride: (...args) => getTerminalFitOverride(context, ...args),
    getAllTerminalFitOverrides: (...args) => getAllTerminalFitOverrides(context, ...args),
    getAllTerminalDrivers: (...args) => getAllTerminalDrivers(context, ...args),
    clearPtyMobilePresence: (...args) => clearPtyMobilePresence(context, ...args),
    retirePtyLayoutQueue: (...args) => retirePtyLayoutQueue(context, ...args),
    releaseExitedPtyFitOverride: (...args) => releaseExitedPtyFitOverride(context, ...args),
    clearExitedPtyFloors: (...args) => clearExitedPtyFloors(context, ...args),
    markTerminalSpawnPublished: (...args) => markTerminalSpawnPublished(context, ...args),
    resetTerminalViewGeneration: (...args) => resetTerminalViewGeneration(context, ...args),
    notifyRemoteTerminalViewPresenceChanged: (...args) =>
      notifyRemoteTerminalViewPresenceChanged(context, ...args)
  }
  const drivers = new RuntimeTerminalDriverController({
    notifyChanged: (ptyId, next) => host.getNotifier()?.terminalDriverChanged(ptyId, next),
    canClaimMobileFloor: (ptyId, clientId) => {
      const softLeaver = state.pendingSoftLeavers.get(ptyId)
      return state.mobileSubscribers.get(ptyId)?.has(clientId) || softLeaver?.clientId === clientId
    },
    commitMobileFloor: (ptyId, clientId, previousFloor, isCurrent) =>
      commands.mobileTookFloor(ptyId, clientId, previousFloor, isCurrent)
  })
  const remoteDesktopFloor = new RemoteDesktopTerminalFloor({
    isMobileDriven: (ptyId) => commands.getDriver(ptyId).kind === 'mobile',
    getTerminalSize: (ptyId) => host.getTerminalSize(ptyId) ?? null,
    resolveHostTarget: (ptyId) => commands.resolveDesktopRestoreTarget(ptyId),
    applyLayout: async (ptyId, target) => {
      state.freshSubscribeGuard.add(ptyId)
      try {
        return await commands.enqueueLayout(ptyId, target)
      } finally {
        state.freshSubscribeGuard.delete(ptyId)
      }
    }
  })
  const viewSubscribers = new RuntimeTerminalViewSubscribers({
    notifyPresenceChanged: (ptyId) => commands.notifyRemoteTerminalViewPresenceChanged(ptyId),
    hasMobileSubscribers: (ptyId) => (state.mobileSubscribers.get(ptyId)?.size ?? 0) > 0,
    isUnattachedLocalCandidate: (ptyId) => host.isUnattachedLocalCandidate(ptyId),
    attachProvider: (ptyId) => {
      const attach = host.getPtyController()?.attach
      return attach ? (async () => attach(ptyId))() : null
    }
  })
  const context: TerminalLayoutContext = {
    state,
    host,
    commands,
    drivers,
    remoteDesktopFloor,
    viewSubscribers
  }
  return { commands, drivers, viewSubscribers }
}
