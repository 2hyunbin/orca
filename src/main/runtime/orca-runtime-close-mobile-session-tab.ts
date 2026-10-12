// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithRefuseUnattributedMobileSessionTabClose } from './orca-runtime-refuse-unattributed-mobile-session-tab-close'
import type { RuntimeSessionTabCloseReason } from '../../shared/runtime-types'
import type { RuntimePtyTabCloseAuthority } from './runtime-terminal-state-records'
import {
  adjudicateAbsentMobileSessionTabClose,
  resolveMobileSessionLifecycleCloseContext,
  type MobileSessionLifecycleCloseHost
} from './mobile-session-lifecycle-close-adjudication'
import type { MobileSessionTabCloseOutcome } from './mobile-session-tab-close-outcome'
import {
  committedMobileSessionTabClose,
  refusedMobileSessionTabClose
} from './mobile-session-tab-close-outcome'
import { getRuntimeBrowserPageRegistry } from './runtime-browser-page-registry'
import type { RuntimeCommandSurfaceHost } from './orca-runtime-core'
import { structuredAgentSessionTabCloseCause } from './structured-agent-session-tab-close-cause'

export class OrcaRuntimeWithCloseMobileSessionTab extends OrcaRuntimeWithRefuseUnattributedMobileSessionTabClose {
  async closeMobileSessionTab(
    worktreeSelector: string,
    tabId: string,
    options: {
      reason?: RuntimeSessionTabCloseReason
      expectedPublicationEpoch?: string
      expectedTerminalHandle?: string
      clientNavigationId?: string
      localPtyTeardownOwnedExternally?: boolean
      expectedPtyCloseAuthority?: RuntimePtyTabCloseAuthority
      force?: boolean
    } = {}
  ): Promise<MobileSessionTabCloseOutcome> {
    const graphEpoch = options.clientNavigationId ? this.captureReadyGraphEpoch() : null
    const explicitWorktreeId = this.getValidatedExplicitWorktreeIdSelector(worktreeSelector)
    const worktreeId =
      explicitWorktreeId ?? (await this.resolveWorktreeSelector(worktreeSelector)).id
    // Only a lifecycle echo needs liveness proof; a user's close does not wait on the PTY inventory.
    const lifecycleEcho = options.reason !== undefined && options.reason !== 'user'
    const observedPtyIds = lifecycleEcho ? await this.refreshMobileSessionPtyRecords() : null
    if (graphEpoch !== null) {
      this.assertStableReadyGraph(graphEpoch)
    }
    const snapshot = this.readSessionTabsSnapshot(worktreeId)
    if (lifecycleEcho && observedPtyIds === null) {
      // Why: keep-on-unknown must also restore the mirror the caller already pruned.
      this.republishMobileSessionTabsSnapshot(worktreeId)
      return refusedMobileSessionTabClose('unknown-liveness', {
        snapshotRepublished: Boolean(snapshot)
      })
    }
    if (
      options.expectedPublicationEpoch !== undefined &&
      snapshot?.publicationEpoch !== options.expectedPublicationEpoch
    ) {
      this.republishMobileSessionTabsSnapshot(worktreeId)
      return refusedMobileSessionTabClose('stale-publication', {
        snapshotRepublished: Boolean(snapshot)
      })
    }
    const ptyCloseAuthority = options.expectedPtyCloseAuthority
      ? this.resolvePtyTabCloseSurfaceAuthority(options.expectedPtyCloseAuthority)
      : null
    const tab = options.expectedPtyCloseAuthority
      ? ptyCloseAuthority?.surface.tab
      : (snapshot?.tabs.find((candidate) => candidate.id === tabId) ??
        snapshot?.tabs.find(
          (candidate) => candidate.type === 'terminal' && candidate.parentTabId === tabId
        ) ??
        snapshot?.tabs.find(
          (candidate) => candidate.type === 'browser' && candidate.browserWorkspaceId === tabId
        ))
    const lifecycleClose = resolveMobileSessionLifecycleCloseContext({
      host: this.getMobileSessionLifecycleCloseHost(),
      worktreeId,
      tabId,
      tab,
      authorityTab: ptyCloseAuthority?.surface.tab,
      snapshot,
      observedPtyIds
    })
    if (!snapshot || !tab) {
      return adjudicateAbsentMobileSessionTabClose({
        host: this.getMobileSessionLifecycleCloseHost(),
        context: lifecycleClose,
        worktreeId,
        snapshot,
        reason: options.reason,
        addressedByPtyCloseAuthority: options.expectedPtyCloseAuthority !== undefined
      })
    }
    if (options.expectedTerminalHandle !== undefined) {
      const terminalIncarnationMatches =
        tab.type === 'terminal' &&
        snapshot.tabs.some(
          (candidate) =>
            candidate.type === 'terminal' &&
            candidate.parentTabId === tab.parentTabId &&
            this.getMobileSessionTerminalHandle(worktreeId, candidate) ===
              options.expectedTerminalHandle
        )
      if (!terminalIncarnationMatches) {
        this.republishMobileSessionTabsSnapshot(worktreeId)
        return refusedMobileSessionTabClose('stale-terminal', {
          snapshotRepublished: true
        })
      }
    }
    let closedSelectionTabIds = [tab.id]
    const finishCommittedClose = (): MobileSessionTabCloseOutcome =>
      committedMobileSessionTabClose(
        this.clientSessionTabSelections,
        worktreeId,
        closedSelectionTabIds
      )
    if (tab.type === 'terminal') {
      // Why: the wire id carries the intent — `parent::leaf` names a pane, `parent` its tab.
      const resolution = this.resolveTerminalCloseTarget(
        worktreeId,
        tab.id === tabId
          ? { kind: 'pane', tabId: tab.parentTabId, leafId: tab.leafId }
          : { kind: 'tab', tabId: tab.parentTabId }
      )
      const closingWholeParent = resolution === 'tab' || resolution === 'last-pane'
      if (closingWholeParent) {
        closedSelectionTabIds = snapshot.tabs.flatMap((candidate) =>
          candidate.type === 'terminal' && candidate.parentTabId === tab.parentTabId
            ? [candidate.id, candidate.parentTabId]
            : []
        )
      }
      // Why: a non-'user' reason is a client-lifecycle echo ("terminal gone"),
      // not authorization to kill. Every destructive branch below can take the
      // whole parent down, so any live PTY under the parent means the echo is a
      // transport artifact: refuse the close and republish the snapshot so the
      // echoing client re-syncs and re-attaches. A reasonless close keeps
      // legacy behavior — old clients send user closes without the field.
      if (options.reason !== undefined && options.reason !== 'user') {
        const leafHasConnectedPty = lifecycleClose.leafHasConnectedPty
        if (lifecycleClose.parentLeaves.some(leafHasConnectedPty)) {
          // Why: when the echo addresses a dead leaf under a live sibling we
          // still refuse (every reachable close path below destroys the whole
          // parent, live sibling included) but skip the republish — re-adding
          // the dead leaf on the echoing client would feed an endless
          // refuse→republish→re-echo cycle.
          const addressedDeadLeaf = tab.id === tabId && !leafHasConnectedPty(tab)
          if (!addressedDeadLeaf) {
            this.republishMobileSessionTabsSnapshot(worktreeId)
          }
          // Why: both markers are skew-safe; clients must restore a mirror only
          // when the host actually republished it, not for a dead leaf.
          return refusedMobileSessionTabClose('live-host-pty', {
            snapshotRepublished: !addressedDeadLeaf
          })
        }
        if (!closingWholeParent || this.tabs.has(tab.parentTabId)) {
          // Why: only the renderer may retire its own tab or split leaf; a
          // remote lifecycle echo must never cross that boundary into a kill.
          return refusedMobileSessionTabClose('retirement-owner')
        }
      }
      if (closingWholeParent) {
        await this.closeHeadlessMobileTerminalTab(worktreeId, snapshot, tab, {
          allowMissingPersistedTab: Boolean(ptyCloseAuthority),
          force: options.force,
          reason: options.reason,
          killPtys:
            options.localPtyTeardownOwnedExternally !== true &&
            (options.reason === undefined || options.reason === 'user'),
          ...(ptyCloseAuthority ? { authorizedPty: ptyCloseAuthority.pty } : {})
        })
        return finishCommittedClose()
      }
      this.closeHeldSessionTab(worktreeId, tab.id, { force: options.force })
      return finishCommittedClose()
    } else if (tab.type === 'browser') {
      // Why: a browser tab can be hosted by a client, by the offscreen backend,
      // or by the renderer; each surface owns a different retirement path.
      const clientPage = tab.browserPageId
        ? getRuntimeBrowserPageRegistry(this).getPage(tab.browserPageId)
        : undefined
      if (clientPage) {
        await (this as RuntimeCommandSurfaceHost<this>).browserTabClose({
          worktree: `id:${worktreeId}`,
          page: clientPage.browserPageId
        })
      } else {
        if (tab.browserPageId) {
          await this.offscreenBrowserBackend?.closeTab(tab.browserPageId).catch(() => {})
        }
        this.closeHeldSessionTab(worktreeId, tab.id, { force: options.force })
      }
    } else if (tab.type === 'agent-session') {
      await this.closeStructuredAgentSessionTab(
        tab,
        structuredAgentSessionTabCloseCause(options.reason)
      )
    } else {
      this.closeHeldSessionTab(worktreeId, tab.id, { force: options.force })
    }
    return finishCommittedClose()
  }

  protected getMobileSessionLifecycleCloseHost(): MobileSessionLifecycleCloseHost {
    return {
      tabs: this.tabs,
      leaves: this.leaves,
      ptysById: this.ptysById,
      findPtyForMobileTerminalTab: (worktreeId, tab) =>
        this.findPtyForMobileTerminalTab(worktreeId, tab),
      republishSnapshot: (worktreeId) => this.republishMobileSessionTabsSnapshot(worktreeId)
    }
  }
}
