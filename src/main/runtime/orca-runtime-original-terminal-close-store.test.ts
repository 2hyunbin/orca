import './rpc/unused-default-rpc-methods.test-fixture'
import { capturedPinnedTerminalCloseRequest } from '../../shared/__fixtures__/captured-pinned-terminal-close.test-fixture'
import { expect, it, vi } from 'vitest'
import type { RuntimeNotifier } from './runtime-notifier-contract'
import type { RuntimeTerminalResolvePane } from '../../shared/runtime-types'
import { join } from 'node:path'
import { Store } from '../persistence/loading-store/store'
import { ProfileStateSqliteAuthority } from '../persistence/profile-state/profile-state-sqlite-authority'
import { TerminalClose } from '../../shared/rpc-contract/terminal-unary-params'
import { RpcDispatcher } from './rpc/dispatcher'
import { TERMINAL_LIFECYCLE_METHODS } from './rpc/methods/terminal/terminal-lifecycle-methods'
import { fixture } from '../persistence/loading-store/profile-state-delayed-authority-fixture'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import { ClientSessionTabSelectionStore } from './client-session-tab-selection'
import { TerminalCloseRuntime } from './__fixtures__/terminal-close-runtime.test-fixture'
import { createCloseContinuityGraphFixture } from './__fixtures__/orca-runtime-terminal-close-continuity-graph-fixture'
import {
  INCARNATION_ID,
  LEAF_ID,
  PTY_ID,
  REPO_ID,
  TAB_ID,
  WORKTREE_ID,
  WORKTREE_PATH,
  makeSession
} from './__fixtures__/orca-runtime-terminal-close-continuity-state-fixture'

const layoutOwner = vi.hoisted(() => ({ main: false }))
vi.mock('../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return layoutOwner.main
  }
}))

export async function confirmedPinnedClose(
  main: boolean,
  boundary?: {
    notify: NonNullable<RuntimeNotifier['closeTerminalTab']>
    onExit: () => void
    run: (host: {
      source: RuntimeTerminalResolvePane
      dispatch: (input: unknown) => Promise<unknown>
      resolve: () => RuntimeTerminalResolvePane
    }) => Promise<unknown>
  }
) {
  layoutOwner.main = main
  const { store, readState, directory, path } = await fixture()
  store.addRepo({
    id: REPO_ID,
    path: WORKTREE_PATH,
    displayName: 'Original retirement',
    badgeColor: '#000000',
    addedAt: 1
  })
  store.setWorkspaceSession(makeSession())
  await store.flushPendingOrThrowAsync()
  const runtime = new TerminalCloseRuntime(store)
  const kill = vi.fn(() => true)
  const closeTerminalTab = vi.fn<NonNullable<RuntimeNotifier['closeTerminalTab']>>(
    async (...args) => boundary?.notify(...args)
  )
  runtime.setNotifier({
    worktreesChanged: vi.fn(),
    reposChanged: vi.fn(),
    activateWorktree: vi.fn(),
    createTerminal: vi.fn(),
    splitTerminal: vi.fn(),
    renameTerminal: vi.fn(),
    focusTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    terminalFitOverrideChanged: vi.fn(),
    terminalDriverChanged: vi.fn(),
    closeTerminalTab
  })
  const stopAndWait = vi.fn(async () => {
    await runtime.onPtyExit(PTY_ID, 0, INCARNATION_ID, { hostExitConfirmed: true })
    expect(runtime.getPtyLivenessVerdict(PTY_ID)?.status).toBe('exited')
    expect(store.getWorkspaceSession().terminalLayoutsByTabId[TAB_ID]).toBeDefined()
    boundary?.onExit()
    return true
  })
  runtime.setPtyController({
    write: () => true,
    kill,
    stopAndWait,
    getForegroundProcess: async () => null
  })
  runtime.attachWindow(1)
  runtime.registerPty(PTY_ID, WORKTREE_ID, null, {
    tabId: TAB_ID,
    leafId: LEAF_ID,
    incarnationId: INCARNATION_ID
  })
  createCloseContinuityGraphFixture({
    runtime,
    ptyId: PTY_ID,
    publishMobileSurface: true,
    getSession: () => store.getWorkspaceSession(),
    setSession: (session) => store.setWorkspaceSession(session),
    markSiblingPtyIncluded: () => {}
  }).syncFixtureGraph()
  const command = {
    type: 'closePane',
    workspace: WORKTREE_ID,
    tabId: TAB_ID,
    leafId: LEAF_ID
  } as const
  await expect(runtime.applyLayoutCommand(command)).resolves.toMatchObject({
    ok: false,
    code: 'last_pane'
  })
  const session = store.getWorkspaceSession()
  store.setWorkspaceSession({
    ...session,
    tabsByWorktree: {
      ...session.tabsByWorktree,
      [WORKTREE_ID]: session.tabsByWorktree[WORKTREE_ID].map((row) => ({
        ...row,
        isPinned: true
      }))
    }
  })
  await store.flushPendingOrThrowAsync()
  const source = runtime.resolveTerminalPane(`${TAB_ID}:${LEAF_ID}`, WORKTREE_ID)
  expect(source.supportsPinCloseConsent).toBe(true)
  const apply = vi.spyOn(store, 'applyLayoutCommand')
  const forget = vi.spyOn(ClientSessionTabSelectionStore.prototype, 'forgetTabs')
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_LIFECYCLE_METHODS })
  const request = capturedPinnedTerminalCloseRequest(source.handle)
  expect(source.presentation).toEqual(request.originalPresentation)
  expect(source.incarnationId).toBe(request.expectedIncarnationId)
  const { force: _consent, ...params } = request
  const dispatch = async (input: unknown) => {
    const replies: string[] = []
    await dispatcher.dispatchStreaming(
      { id: 'confirmed-capture', authToken: 'fixture', method: 'terminal.close', params: input },
      (reply) => replies.push(reply)
    )
    return JSON.parse(replies[0])
  }
  await expect(dispatch(params)).resolves.toMatchObject({ ok: false })
  await expect(
    store.applyLayoutCommand(command, ['local'], {
      originalPresentation: request.originalPresentation
    })
  ).rejects.toThrow('terminal_tab_pinned')
  expect(stopAndWait).not.toHaveBeenCalled()
  expect(store.getWorkspaceSession().tabsByWorktree[WORKTREE_ID]).toHaveLength(1)
  await expect(
    dispatch({ ...params, expectedIncarnationId: 'successor', force: true })
  ).resolves.toMatchObject({ ok: false })
  expect(stopAndWait).not.toHaveBeenCalled()
  const hostResult = boundary
    ? boundary.run({
        source,
        dispatch,
        resolve: () => runtime.resolveTerminalPane(`${TAB_ID}:${LEAF_ID}`, WORKTREE_ID)
      })
    : dispatch(TerminalClose.parse(request))
  await expect(hostResult).resolves.toMatchObject({
    ok: true,
    result: { close: { ptyKilled: true } }
  })
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    expect(apply).toHaveResolvedWith({ ok: true, result: { closed: [TAB_ID] } })
  }
  expect(forget).toHaveBeenCalledWith(WORKTREE_ID, [TAB_ID])
  expect(stopAndWait).toHaveBeenCalledExactlyOnceWith(
    PTY_ID,
    expect.objectContaining({ expectedIncarnationId: INCARNATION_ID })
  )
  expect(kill).not.toHaveBeenCalled()
  expect(closeTerminalTab).toHaveBeenCalledExactlyOnceWith(TAB_ID, {
    localPtyTeardownOwnedExternally: true,
    force: true,
    originalSurface: TerminalClose.parse(params).originalPresentation?.identity
  })
  expect(store.getWorkspaceSession().tabsByWorktree[WORKTREE_ID]).toEqual([])
  expect(readState().workspaceSession.tabsByWorktree[WORKTREE_ID]).toEqual([])
  expect(store.getWorkspaceSession().closedTerminalTabTombstonesByTabId?.[TAB_ID]).toBeDefined()
  await store.freezeWritesAsync()
  const reloaded = new Store({
    dataFile: join(directory, 'orca-data.json'),
    profileStateAuthority: new ProfileStateSqliteAuthority(path, 'coordination-test')
  })
  try {
    expect(reloaded.getWorkspaceSession().tabsByWorktree[WORKTREE_ID]).toEqual([])
    expect(
      reloaded.getWorkspaceSession().closedTerminalTabTombstonesByTabId?.[TAB_ID]
    ).toBeDefined()
  } finally {
    await reloaded.freezeWritesAsync()
  }
}

it.each([false, true])(
  'confirmed pinned captured close retires and reloads through real Store, main=%s',
  (main) => confirmedPinnedClose(main)
)
