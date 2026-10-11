import { RuntimeHeadlessTerminalTabClose } from '../session-tabs/headless-terminal-tab-close'
import { RuntimeExplicitTerminalCloseStops } from '../session-tabs/explicit-terminal-close-stops'
import { RuntimeFloatingSessionLiveness } from '../terminal/lifecycle/floating-session-liveness'
import { RuntimeSessionGraphPromotion } from '../session-graph/session-graph-promotion'
import { createHeadlessSessionTabCommands } from '../session-tabs/headless-session-tab-commands'
import type { SessionLifecyclePorts } from './session-lifecycle-ports'

export function createRuntimeExplicitTerminalCloseStops(ports: () => SessionLifecyclePorts) {
  return new RuntimeExplicitTerminalCloseStops({
    get markPtyStopRequested() {
      return ports().bindRuntimeMethod(ports().markPtyStopRequested())
    },
    get getPty() {
      return ports().getPty
    },
    get getPtyController() {
      return ports().getPtyController
    },
    get markPtyLivenessUnverifiable() {
      return ports().bindRuntimeMethod(ports().markPtyLivenessUnverifiable())
    },
    get getPtyLivenessVerdict() {
      return ports().bindRuntimeMethod(ports().getPtyLivenessVerdict())
    }
  })
}

export function createRuntimeFloatingSessionLiveness(ports: () => SessionLifecyclePorts) {
  return new RuntimeFloatingSessionLiveness({
    get getPtyController() {
      return ports().getPtyController
    },
    get getSnapshot() {
      return ports().getSnapshot
    },
    get getMobileTerminalPaneKey() {
      return ports().bindRuntimeMethod(ports().getMobileTerminalPaneKey())
    },
    get ptys() {
      return ports().ptyRecords
    },
    get leaves() {
      return ports().leaves
    },
    get recordPtyWorktree() {
      return ports().bindRuntimeMethod(ports().recordPtyWorktree())
    },
    get markPtyLivenessLive() {
      return ports().bindRuntimeMethod(ports().markPtyLivenessLive())
    },
    get refreshPtyForegroundAgent() {
      return ports().bindRuntimeMethod(ports().refreshPtyForegroundAgent())
    },
    get leafExistsForPty() {
      return ports().bindRuntimeMethod(ports().leafExistsForPty())
    },
    get pruneDisconnectedPtyRecords() {
      return ports().bindRuntimeMethod(ports().pruneDisconnectedPtyRecords())
    }
  })
}

export function createRuntimeSessionGraphPromotion(ports: () => SessionLifecyclePorts) {
  return new RuntimeSessionGraphPromotion({
    get state() {
      return ports().state
    },
    get getStore() {
      return ports().getStore
    },
    get ptys() {
      return ports().getPtyValues
    },
    get getWorkspaceSessionHostIdForWorktree() {
      return ports().bindRuntimeMethod(ports().getWorkspaceSessionHostIdForWorktree())
    },
    get persistWindowlessPtyBindingsForDesktopAttach() {
      return ports().bindRuntimeMethod(ports().persistWindowlessPtyBindingsForDesktopAttach())
    },
    get beginGraphReload() {
      return ports().bindRuntimeMethod(ports().beginGraphReload())
    }
  })
}

export function createRuntimeHeadlessSessionTabCommands(ports: () => SessionLifecyclePorts) {
  return createHeadlessSessionTabCommands({
    getWorkspaceSessionForWorktree: (worktreeId) =>
      ports().bindRuntimeMethod(ports().getWorkspaceSessionForWorktree())(worktreeId),
    get canPersistWorkspaceSession() {
      return ports().canPersistWorkspaceSession
    },
    setWorkspaceSessionForWorktree: (worktreeId, session) =>
      ports().bindRuntimeMethod(ports().readWorkspaceSessionWriter())(worktreeId, session),
    get getMobileSessionSnapshot() {
      return ports().getSnapshot
    },
    resolveMobileSessionHostTabId: (snapshot, tabId) =>
      ports().bindRuntimeMethod(ports().resolveMobileSessionHostTabId())(snapshot, tabId),
    normalizeMobileSessionTabOrder: (snapshot, group, order) =>
      ports().bindRuntimeMethod(ports().normalizeMobileSessionTabOrder())(snapshot, group, order),
    toMobileSessionTabsResult: (snapshot) =>
      ports().bindRuntimeMethod(ports().toMobileSessionTabsResult())(snapshot),
    storeMobileSessionSnapshot: (worktreeId, snapshot) =>
      ports().bindRuntimeMethod(ports().storeMobileSessionSnapshot())(worktreeId, snapshot),
    emitMobileSessionTabsSnapshot: (snapshot) =>
      ports().bindRuntimeMethod(ports().emitMobileSessionTabsSnapshot())(snapshot)
  })
}

export function createRuntimeHeadlessTerminalTabClose(ports: () => SessionLifecyclePorts) {
  return new RuntimeHeadlessTerminalTabClose({
    get getMobileSessionTerminalRetirementProof() {
      return ports().bindRuntimeMethod(ports().getMobileSessionTerminalRetirementProof())
    },
    get captureTerminalTabRetirement() {
      return ports().bindRuntimeMethod(ports().captureTerminalTabRetirement())
    },
    get closeTerminalSurface() {
      return ports().bindRuntimeMethod(ports().closeTerminalSurface())
    },
    get getSnapshot() {
      return ports().getSnapshot
    },
    get clearRuntimeSessionOwnershipForMobileTab() {
      return ports().bindRuntimeMethod(
        ports().clearRuntimeSessionOwnershipForMobileTabHeadlessTerminalTabClose()
      )
    },
    get setPairedRendererSessionOwnership() {
      return ports().bindRuntimeMethod(ports().setPairedRendererSessionOwnership())
    },
    get getMobileTerminalLeafPtyIds() {
      return ports().bindRuntimeMethod(ports().getMobileTerminalLeafPtyIds())
    },
    get findPtyForMobileTerminalTab() {
      return ports().bindRuntimeMethod(ports().findPtyForMobileTerminalTab())
    },
    get getPtyController() {
      return ports().getPtyController
    },
    get storeMobileSessionSnapshot() {
      return ports().bindRuntimeMethod(ports().storeMobileSessionSnapshot())
    },
    get emitMobileSessionTabsSnapshot() {
      return ports().bindRuntimeMethod(ports().emitMobileSessionTabsSnapshot())
    }
  })
}
