import type {
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab,
  RuntimeMobileSessionRetiredTerminalSurface
} from '../../../shared/runtime-types'
import { parseAppSshPtyId } from '../../../shared/ssh-pty-id'
import { buildHeadlessMobileSessionTabGroups } from '../mobile-session-layout-projection'
import { appendRetiredTerminalSurfaceProofs } from '../mobile-session-terminal-retirement-proof'
import type { RuntimePtyWorktreeRecord } from '../runtime-terminal-state-records'
import type { RuntimeSessionTabCloseReason } from '../../../shared/runtime-session-contracts'
import type { captureAcknowledgedTerminalTabRetirement } from '../workspace-session-terminal-tab-retirement-identity'
import type { TerminalSurfaceCloseOptions } from '../terminal-surface-close'
import type { TerminalSurfaceCloseTarget } from '../../../shared/terminal-surface-close-target'
import type { RuntimePtyController } from '../runtime-pty-controller-contract'

export type RuntimeHeadlessTerminalTabCloseHost = {
  getMobileSessionTerminalRetirementProof(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab,
    pty?: RuntimePtyWorktreeRecord
  ): RuntimeMobileSessionRetiredTerminalSurface | null
  captureTerminalTabRetirement(
    worktreeId: string,
    tabId: string
  ): ReturnType<typeof captureAcknowledgedTerminalTabRetirement>
  closeTerminalSurface(
    worktreeId: string,
    target: TerminalSurfaceCloseTarget,
    options: TerminalSurfaceCloseOptions
  ): Promise<string[]>
  getSnapshot(worktreeId: string): RuntimeMobileSessionTabsSnapshot | undefined
  clearRuntimeSessionOwnershipForMobileTab(
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot,
    tabId: string
  ): void
  setPairedRendererSessionOwnership(ptyId: string, owned: boolean): void
  getMobileTerminalLeafPtyIds(tab: RuntimeMobileSessionTerminalTab): string[]
  findPtyForMobileTerminalTab(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab
  ): RuntimePtyWorktreeRecord | null
  getPtyController(): Pick<RuntimePtyController, 'kill'> | null
  storeMobileSessionSnapshot(
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot
  ): RuntimeMobileSessionTabsSnapshot
  emitMobileSessionTabsSnapshot(snapshot: RuntimeMobileSessionTabsSnapshot): void
}

export class RuntimeHeadlessTerminalTabClose {
  constructor(private readonly host: RuntimeHeadlessTerminalTabCloseHost) {}

  async closeHeadlessMobileTerminalTab(
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot,
    tab: RuntimeMobileSessionTerminalTab,
    options: {
      allowMissingPersistedTab?: boolean
      killPtys?: boolean
      authorizedPty?: RuntimePtyWorktreeRecord
      force?: boolean
      reason?: RuntimeSessionTabCloseReason
    } = {}
  ): Promise<void> {
    const closedParentTabId = tab.parentTabId
    const retirementProofs = snapshot.tabs.flatMap((candidate) => {
      if (candidate.type !== 'terminal' || candidate.parentTabId !== closedParentTabId) {
        return []
      }
      const proof = this.host.getMobileSessionTerminalRetirementProof(
        worktreeId,
        candidate,
        options.authorizedPty
      )
      return proof ? [proof] : []
    })
    const acknowledgeRetirement = this.host.captureTerminalTabRetirement(
      worktreeId,
      closedParentTabId
    )
    const projectedPtyIds = await this.host.closeTerminalSurface(
      worktreeId,
      { kind: 'tab', tabId: closedParentTabId },
      {
        allowMissing: options.allowMissingPersistedTab,
        force: options.force,
        reason: options.reason
      }
    )
    if (!acknowledgeRetirement().matches) {
      throw new Error('terminal_pane_owner_changed')
    }
    // Renderer frames may add other tabs while the durable close is in flight.
    snapshot = this.host.getSnapshot(worktreeId) ?? snapshot
    this.host.clearRuntimeSessionOwnershipForMobileTab(worktreeId, snapshot, closedParentTabId)
    if (options.authorizedPty) {
      options.authorizedPty.runtimeSessionOwned = false
      this.host.setPairedRendererSessionOwnership(options.authorizedPty.ptyId, false)
    }
    // Why: local provider ids can be reused after restart, so a dormant
    // persisted id is not kill authority. SSH relay ids remain durable exact
    // identities even before pane metadata reconnects.
    const ptyIdsToKill = new Set(projectedPtyIds.filter((ptyId) => parseAppSshPtyId(ptyId)))
    for (const candidate of snapshot.tabs) {
      if (candidate.type !== 'terminal' || candidate.parentTabId !== closedParentTabId) {
        continue
      }
      const authorizedPty =
        options.authorizedPty &&
        this.host.getMobileTerminalLeafPtyIds(candidate).includes(options.authorizedPty.ptyId)
          ? options.authorizedPty
          : null
      const livePty = this.host.findPtyForMobileTerminalTab(worktreeId, candidate) ?? authorizedPty
      const ptyId = livePty?.ptyId ?? candidate.ptyId
      const hasOtherOwner = snapshot.tabs.some(
        (other) =>
          other.type === 'terminal' &&
          other.parentTabId !== closedParentTabId &&
          other.ptyId === ptyId
      )
      if (ptyId && !hasOtherOwner && (livePty || parseAppSshPtyId(ptyId))) {
        // Why: a live serve leaf can exist before its debounced binding reaches
        // persistence. Include it from the authoritative snapshot so split
        // close cannot leave a provider process behind.
        ptyIdsToKill.add(ptyId)
      }
    }
    if (options.killPtys !== false) {
      for (const ptyId of ptyIdsToKill) {
        this.host.getPtyController()?.kill(ptyId)
      }
    }
    const nextTabs = snapshot.tabs.filter((candidate) => {
      if (candidate.type !== 'terminal' || candidate.parentTabId !== closedParentTabId) {
        return true
      }
      return false
    })
    const active = nextTabs.find((candidate) => candidate.isActive) ?? nextTabs[0] ?? null
    // A close is not a handover: the generation publishing this worktree still is. Minting an epoch
    // here published a stranger for a worktree the renderer owns, and a client that retires what it
    // displaces then rejected that renderer's own next frame. The sibling headless writers carry the
    // stored epoch forward for the same reason; `...snapshot` is what does it here.
    const nextSnapshot: RuntimeMobileSessionTabsSnapshot = {
      ...snapshot,
      snapshotVersion: snapshot.snapshotVersion + 1,
      activeTabId: active?.id ?? null,
      activeTabType: active?.type ?? null,
      tabGroups: buildHeadlessMobileSessionTabGroups(
        worktreeId,
        nextTabs,
        active,
        snapshot.tabGroups
      ),
      ...(retirementProofs.length > 0
        ? {
            retiredTerminalSurfaces: appendRetiredTerminalSurfaceProofs(
              snapshot.retiredTerminalSurfaces,
              retirementProofs
            )
          }
        : {}),
      tabs: nextTabs
    }
    this.host.storeMobileSessionSnapshot(worktreeId, nextSnapshot)
    this.host.emitMobileSessionTabsSnapshot(nextSnapshot)
  }
}
