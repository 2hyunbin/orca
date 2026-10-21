// Layout-owner builds bind a terminal's pane before they register it (L80): the PTY host's spawn
// commit writes the binding, then registers. Fixtures that register terminals themselves, or fake
// the spawn, stand in for that commit here. Window-owned builds write nothing, as before.
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { getConnectionExecutionHostId } from '../../shared/execution-host'

export type BoundPane = { worktreeId: string; tabId: string; leafId: string; ptyId: string }

type SessionStore = {
  getWorkspaceSession?: (hostId?: string) => WorkspaceSessionState | null | undefined
  setWorkspaceSession?: (session: WorkspaceSessionState, hostId?: string) => void
  getWorkspaceSessionHostIds?: () => readonly string[]
}

// The partitions a store without its own host list has had panes bound in.
const boundHostIdsByStore = new WeakMap<SessionStore, Set<string>>()

const installedSessionStores = new WeakSet<SessionStore>()

/** Drops the in-memory session bindPaneFirst gave a store shared across tests, so none leaks. */
export function forgetInstalledPaneSession(shared: object): void {
  const store: SessionStore = shared
  if (!installedSessionStores.delete(store)) {
    return
  }
  delete store.getWorkspaceSession
  delete store.setWorkspaceSession
  if (boundHostIdsByStore.delete(store)) {
    delete store.getWorkspaceSessionHostIds
  }
}

function storeOf(runtime: object): SessionStore | null {
  const store: unknown = Reflect.get(runtime, 'store')
  return store && typeof store === 'object' ? store : null
}

function containsLeaf(node: unknown, leafId: string): boolean {
  if (!node || typeof node !== 'object') {
    return false
  }
  return Reflect.get(node, 'type') === 'leaf'
    ? Reflect.get(node, 'leafId') === leafId
    : containsLeaf(Reflect.get(node, 'first'), leafId) ||
        containsLeaf(Reflect.get(node, 'second'), leafId)
}

/** The session with the pane bound to its terminal: the tab and leaf added when missing. */
export function withBoundPane(
  session: WorkspaceSessionState,
  pane: BoundPane
): WorkspaceSessionState {
  const tabs = session.tabsByWorktree[pane.worktreeId] ?? []
  const hasTab = tabs.some((tab) => tab.id === pane.tabId)
  const layout = session.terminalLayoutsByTabId[pane.tabId]
  const leaf = { type: 'leaf' as const, leafId: pane.leafId }
  const root = !layout?.root
    ? leaf
    : containsLeaf(layout.root, pane.leafId)
      ? layout.root
      : { type: 'split' as const, direction: 'vertical' as const, first: layout.root, second: leaf }
  return {
    ...session,
    tabsByWorktree: {
      ...session.tabsByWorktree,
      [pane.worktreeId]: hasTab
        ? tabs
        : [
            ...tabs,
            {
              id: pane.tabId,
              ptyId: pane.ptyId,
              worktreeId: pane.worktreeId,
              title: 'Terminal',
              customTitle: null,
              color: null,
              sortOrder: tabs.length,
              createdAt: 1
            }
          ]
    },
    terminalLayoutsByTabId: {
      ...session.terminalLayoutsByTabId,
      [pane.tabId]: {
        ...layout,
        activeLeafId: layout?.activeLeafId ?? pane.leafId,
        expandedLeafId: layout?.expandedLeafId ?? null,
        root,
        ptyIdsByLeafId: { ...layout?.ptyIdsByLeafId, [pane.leafId]: pane.ptyId }
      }
    }
  }
}

/**
 * As the spawn commit: binds the pane in the runtime's store session before registration. A
 * store with no session gets an in-memory one, as a profile always has. No-op with the switch off.
 */
export function bindPaneFirst(runtime: object, pane: BoundPane, hostId = 'local'): void {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    return
  }
  const store = storeOf(runtime)
  if (!store) {
    throw new Error('bindPaneFirst needs a runtime with a store: main binds panes in its layout')
  }
  if (!store.getWorkspaceSession || !store.setWorkspaceSession) {
    installedSessionStores.add(store)
    // Partitioned by execution host, as the profile Store keeps sessions.
    const sessions = new Map<string, WorkspaceSessionState>()
    store.getWorkspaceSession = (host = 'local') =>
      sessions.get(host) ?? getDefaultWorkspaceSession()
    store.setWorkspaceSession = (next, host = 'local') => {
      sessions.set(host, next)
    }
  }
  if (!store.getWorkspaceSessionHostIds) {
    const hostIds = new Set<string>()
    boundHostIdsByStore.set(store, hostIds)
    store.getWorkspaceSessionHostIds = () => [...hostIds]
  }
  boundHostIdsByStore.get(store)?.add(hostId)
  const current = store.getWorkspaceSession(hostId) ?? getDefaultWorkspaceSession()
  store.setWorkspaceSession(withBoundPane(current, pane), hostId)
}

/** As main's pane move to a new tab: the pane leaves `fromTabId` (a tab left empty goes) first. */
export function movePaneFirst(
  runtime: object,
  fromTabId: string,
  pane: BoundPane,
  hostId = 'local'
): void {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    return
  }
  const store = storeOf(runtime)
  const session = store?.getWorkspaceSession?.(hostId)
  if (!store?.setWorkspaceSession || !session) {
    throw new Error('movePaneFirst needs a pane bindPaneFirst bound')
  }
  const { [fromTabId]: _left, ...layouts } = session.terminalLayoutsByTabId
  store.setWorkspaceSession(
    {
      ...session,
      tabsByWorktree: {
        ...session.tabsByWorktree,
        [pane.worktreeId]: (session.tabsByWorktree[pane.worktreeId] ?? []).filter(
          (tab) => tab.id !== fromTabId
        )
      },
      terminalLayoutsByTabId: layouts
    },
    hostId
  )
  bindPaneFirst(runtime, pane, hostId)
}

/** registerPty as the PTY host's commit runs it: the pane is bound first. */
export function registerBoundPty(
  runtime: {
    registerPty: (
      ptyId: string,
      worktreeId: string,
      connectionId?: string | null,
      binding?: { tabId: string; leafId: string } & Record<string, unknown>
    ) => void
  },
  ptyId: string,
  worktreeId: string,
  connectionId: string | null,
  binding: { tabId: string; leafId: string } & Record<string, unknown>
): void {
  bindPaneFirst(runtime, { worktreeId, tabId: binding.tabId, leafId: binding.leafId, ptyId })
  runtime.registerPty(ptyId, worktreeId, connectionId, binding)
}

/** A fake PTY host spawn that commits as the real one does: it binds the pane, then answers. */
export function committingSpawn<
  Args extends { worktreeId?: string; tabId?: string; leafId?: string },
  Result extends { id: string }
>(
  runtime: object,
  spawn: (args: Args) => Promise<Result>,
  hostId = 'local'
): (args: Args) => Promise<Result> {
  return async (args) => {
    const result = await spawn(args)
    if (args.worktreeId && args.tabId && args.leafId && typeof result?.id === 'string') {
      bindPaneFirst(
        runtime,
        {
          worktreeId: args.worktreeId,
          tabId: args.tabId,
          leafId: args.leafId,
          ptyId: result.id
        },
        hostId
      )
    }
    return result
  }
}

/**
 * As the PTY host's commit, for a store with sessions: binds the pane the runtime wrote before the
 * spawn, and refuses one closed since. A store that cannot write panes gets the one it would have.
 */
function commitIntoWrittenPane(runtime: object, args: SpawnArgs, result: unknown): void {
  const ptyId: unknown = result && typeof result === 'object' ? Reflect.get(result, 'id') : null
  const store = storeOf(runtime)
  if (
    !store?.getWorkspaceSession ||
    !args.worktreeId ||
    !args.tabId ||
    !args.leafId ||
    typeof ptyId !== 'string'
  ) {
    return
  }
  const { worktreeId, tabId, leafId } = args
  const holdsPane = (hostId: string): boolean => {
    const session = store.getWorkspaceSession?.(hostId)
    return (
      (session?.tabsByWorktree?.[worktreeId]?.some((tab) => tab.id === tabId) ?? false) &&
      containsLeaf(session?.terminalLayoutsByTabId?.[tabId]?.root, leafId)
    )
  }
  // The partition the runtime wrote the pane in; with no admission, the one bindPaneFirst uses.
  const hostId = !Reflect.has(store, 'admitTerminalPane')
    ? 'local'
    : [getConnectionExecutionHostId(args.connectionId), 'local'].find(holdsPane)
  if (hostId) {
    bindPaneFirst(runtime, { worktreeId, tabId, leafId, ptyId }, hostId)
  }
}

type SpawnArgs = Parameters<NonNullable<RuntimePtyController['spawn']>>[0]

type PtyControllerRuntimePrototype = {
  setPtyController: (controller: RuntimePtyController | null) => void
}

/**
 * Gives every fake PTY controller a suite installs the real controller's spawn commit, which binds
 * the pane before the runtime registers it. A spawn already committing binds the same pane again.
 */
export function commitFakeSpawnsInRuntimeTests(prototype: PtyControllerRuntimePrototype): void {
  const setPtyController = prototype.setPtyController
  prototype.setPtyController = function (controller) {
    // No spawn, nothing to commit: the suite's own object, so its methods see themselves as `this`.
    if (typeof controller?.spawn !== 'function') {
      setPtyController.call(this, controller)
      return
    }
    const commit = (args: SpawnArgs, result: unknown): void =>
      commitIntoWrittenPane(this, args, result)
    const committed = new WeakMap<object, unknown>()
    // A proxy, not a copy: a suite that swaps or reads its controller later sees its own object.
    setPtyController.call(
      this,
      new Proxy(controller, {
        get(target, prop, receiver) {
          const value: unknown = Reflect.get(target, prop, receiver)
          if (prop !== 'spawn' || typeof value !== 'function') {
            return value
          }
          if (!committed.has(value)) {
            committed.set(value, async (args: SpawnArgs) => {
              const result: unknown = await Reflect.apply(value, target, [args])
              commit(args, result)
              return result
            })
          }
          return committed.get(value)
        }
      })
    )
  }
}
