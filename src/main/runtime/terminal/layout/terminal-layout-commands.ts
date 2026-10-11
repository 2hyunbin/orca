import type { TerminalFitOverride } from './terminal-layout-context'
import type {
  ApplyLayoutResult,
  DriverState,
  PtyLayoutState,
  PtyLayoutTarget
} from '../../orca-runtime-core'
import type { TerminalInputKind } from '../../../../shared/terminal-input-kind'

export type TerminalLayoutCommands = {
  mobileTookFloor(
    ptyId: string,
    clientId: string,
    previousFloor?: DriverState,
    isCurrent?: () => boolean
  ): Promise<void>
  updateMobileViewport(
    ptyId: string,
    clientId: string,
    viewport: { cols: number; rows: number }
  ): Promise<{ updated: boolean; applied: boolean }>
  reclaimTerminalForDesktop(ptyId: string): Promise<boolean>
  cancelPendingDriverMutations(ptyId: string): void
  releaseDesktopTakeBack(ptyId: string): void
  getAutoRestoreFitMs(): number | null
  cancelAllPendingFitRestoreTimers(): void
  getMobileAutoRestoreFitMs(): number | null
  setMobileAutoRestoreFitMs(ms: number | null): number | null
  pickMostRecentActor(
    inner: Map<string, { clientId: string; lastActedAt: number }>
  ): { clientId: string; lastActedAt: number } | null
  pickEarliestRestoreTarget(
    inner: Map<
      string,
      { subscribedAt: number; previousCols: number | null; previousRows: number | null }
    >
  ): { previousCols: number; previousRows: number } | null
  getLayout(ptyId: string): PtyLayoutState | null
  isFreshSubscribe(ptyId: string): boolean
  resolveDesktopRestoreTarget(ptyId: string): { cols: number; rows: number }
  coalescesWith(prev: PtyLayoutTarget, next: PtyLayoutTarget): boolean
  enqueueLayout(ptyId: string, target: PtyLayoutTarget): Promise<ApplyLayoutResult>
  runLayoutSlot(
    ptyId: string,
    target: PtyLayoutTarget,
    waiters: ((r: ApplyLayoutResult) => void)[]
  ): Promise<ApplyLayoutResult>
  applyLayout(ptyId: string, target: PtyLayoutTarget): Promise<ApplyLayoutResult>
  setMobileDisplayMode(ptyId: string, mode: 'auto' | 'desktop'): void
  getMobileDisplayMode(ptyId: string): 'auto' | 'desktop'
  isMobileSubscriberActive(ptyId: string): boolean
  updateMobileSubscriberViewport(
    ptyId: string,
    clientId: string,
    viewport: { cols: number; rows: number }
  ): void
  handleMobileSubscribe(
    ptyId: string,
    clientId: string,
    viewport?: { cols: number; rows: number }
  ): Promise<boolean>
  handleMobileSubscribeInternal(
    ptyId: string,
    clientId: string,
    viewport?: { cols: number; rows: number }
  ): Promise<boolean>
  handleMobileUnsubscribe(ptyId: string, clientId: string): void
  applyMobileDisplayMode(ptyId: string): Promise<boolean>
  onExternalPtyResize(ptyId: string, cols: number, rows: number): void
  recordRendererGeometry(ptyId: string, cols: number, rows: number): void
  getLastRendererSize(ptyId: string): { cols: number; rows: number } | null
  refreshRendererGeometry(ptyId: string, cols: number, rows: number): void
  isResizeSuppressed(): boolean
  suppressResizesForMs(ms: number): void
  onClientDisconnected(clientId: string): void
  registerRemoteTerminalViewSubscriber(ptyId: string): () => void
  isKnownUnattachedLocalDaemonPty(ptyId: string): boolean
  reconcileSubscriberDrivenProviderAttach(ptyId: string): void
  registerRawTerminalViewSubscriber(ptyId: string): () => void
  hasRawTerminalViewSubscriber(ptyId: string): boolean
  hasRemoteTerminalViewSubscriber(ptyId: string): boolean
  isMobileTerminalQueryReplyAuthority(ptyId: string, clientId: string): boolean
  subscribeToFitOverrideChanges(
    ptyId: string,
    listener: (event: {
      mode: 'mobile-fit' | 'remote-desktop-fit' | 'desktop-fit'
      cols: number
      rows: number
    }) => void
  ): () => void
  subscribeToDriverChanges(ptyId: string, listener: (driver: DriverState) => void): () => void
  notifyFitOverrideListeners(
    ptyId: string,
    mode: 'mobile-fit' | 'remote-desktop-fit' | 'desktop-fit',
    cols: number,
    rows: number
  ): void
  subscribeToTerminalResize(
    ptyId: string,
    listener: (event: {
      cols: number
      rows: number
      displayMode: string
      reason: string
      seq?: number
    }) => void
  ): () => void
  notifyTerminalResize(
    ptyId: string,
    event: { cols: number; rows: number; displayMode: string; reason: string; seq?: number }
  ): void
  getDriver(ptyId: string): DriverState
  setDriver(ptyId: string, next: DriverState): void
  isPtyResizeDrivenRemotely(ptyId: string): boolean
  isRemoteDesktopResizeDriven(ptyId: string): boolean
  isRemoteDesktopViewerOwner(ptyId: string, subscriptionKey: string): boolean
  getRemoteDesktopFitHold(
    ptyId: string,
    subscriptionKey: string
  ): { mode: 'remote-desktop-fit' | 'desktop-fit'; cols: number; rows: number }
  recordRemoteDesktopHostReclaimTarget(ptyId: string, cols: number, rows: number): void
  applyRemoteDesktopLayout(ptyId: string): Promise<boolean>
  updateRemoteDesktopViewer(
    ptyId: string,
    subscriptionKey: string,
    clientId: string,
    cols: number,
    rows: number,
    claim?: boolean
  ): Promise<boolean>
  claimRemoteDesktopViewer(ptyId: string, subscriptionKey: string): Promise<boolean>
  claimRemoteDesktopHost(ptyId: string, cols: number, rows: number): Promise<boolean>
  noteRemoteDesktopHostInput(ptyId: string, inputKind: TerminalInputKind, data: string): void
  unregisterRemoteDesktopViewer(ptyId: string, subscriptionKey: string): Promise<boolean>
  unregisterRemoteDesktopViewers(
    ptyId: string,
    subscriptionKeys: Iterable<string>
  ): Promise<boolean>
  refreshRemoteDesktopViewer(
    ptyId: string,
    clientId: string,
    cols: number,
    rows: number,
    claim?: boolean
  ): Promise<boolean>
  updateDesktopViewport(ptyId: string, viewport: { cols: number; rows: number }): Promise<boolean>
  markMobileActor(ptyId: string, clientId: string): void
  beginMobileInputFloor(
    ptyId: string,
    clientId: string
  ): { commit: () => Promise<void>; rollback: () => void } | null
  resizeForClient(
    ptyId: string,
    mode: 'mobile-fit' | 'restore',
    clientId: string,
    cols?: number,
    rows?: number
  ): Promise<{
    cols: number
    rows: number
    previousCols: number | null
    previousRows: number | null
    mode: 'mobile-fit' | 'desktop-fit'
  }>
  getTerminalFitOverride(ptyId: string): TerminalFitOverride | null
  getAllTerminalFitOverrides(): Map<
    string,
    { mode: 'mobile-fit' | 'remote-desktop-fit'; cols: number; rows: number }
  >
  getAllTerminalDrivers(): Map<string, DriverState>
  clearPtyMobilePresence(ptyId: string): void
  retirePtyLayoutQueue(ptyId: string): void
  releaseExitedPtyFitOverride(ptyId: string): void
  clearExitedPtyFloors(ptyId: string): void
  markTerminalSpawnPublished(ptyId: string): void
  resetTerminalViewGeneration(ptyId: string): void
  notifyRemoteTerminalViewPresenceChanged(ptyId: string): void
}
