import { afterEach, describe, expect, it, vi } from 'vitest'
import { WSL_MOVE_BROWSER_COOKIES_STORE_ID } from '../../../shared/wsl-move/wsl-move-browser-cookie-copy'
import {
  PERSISTED_STATE_DISPOSITIONS,
  WORKSPACE_SESSION_DISPOSITIONS,
  type WslMoveFieldDisposition
} from '../../../shared/wsl-move/wsl-move-dispositions'
import { OUT_OF_STORE_DISPOSITIONS } from '../../../shared/wsl-move/wsl-move-out-of-store-dispositions'
import type { WslMoveRendererRewriteStoreId } from '../../../shared/wsl-move/wsl-move-renderer-rewrite-types'
import {
  LOCAL_STORAGE_MODULE_DISPOSITIONS,
  SQLITE_TABLE_DISPOSITIONS
} from '../../../shared/wsl-move/wsl-move-storage-dispositions'
import { UI_STATE_DISPOSITIONS } from '../../../shared/wsl-move/wsl-move-ui-dispositions'
import { registerWslMoveDesktopRewriteRegistry } from './wsl-move-desktop-rewrite-registry'
import {
  isWslMoveDesktopRewriteRegistryComplete,
  listWslMoveDesktopRewriteStores,
  resetWslMoveDesktopRewriteStoresForTests,
  WSL_MOVE_DESKTOP_REWRITE_REGISTRY_COMPLETE
} from './wsl-move-desktop-rewrite-stores'
import { WSL_MOVE_HOST_AUTOMATIONS_STORE_ID } from './wsl-move-host-automations-rewrite'
import { WSL_MOVE_ORCHESTRATION_HISTORY_STORE_ID } from './wsl-move-orchestration-history-rewrite'

vi.mock('../../browser/browser-partition-cookie-copy', () => ({
  copyBrowserPartitionCookies: vi.fn(),
  flushBrowserPartitionCookies: vi.fn()
}))
vi.mock('../../browser/browser-session-registry', () => ({ browserSessionRegistry: {} }))
vi.mock('../../browser/browser-session-startup', () => ({ browserSessionsInitialized: vi.fn() }))
vi.mock('../../browser/browser-route-partition-binding-runtime', () => ({
  activeBrowserRoutePartitionOrcaProfileId: vi.fn(),
  currentBrowserRoutePartitionBindingStore: vi.fn()
}))
vi.mock('../../browser/browser-route-partition-storage-dependencies', () => ({
  releaseEvictedBrowserRoutePartitionStorage: vi.fn()
}))

const UI_ROUTING = 'ui-routing'
const SESSION_GLOBALS = 'session-globals'
const HOST_SESSION_SEED = 'host-session-seed'
const renderer = (id: WslMoveRendererRewriteStoreId): string => id

/**
 * The store that carries out each disposition row it names. Keys are `<table>.<row>` after the
 * disposition tables; every row here must exist, and every registered store must appear.
 */
const STORE_BY_ROW: Record<string, string> = {
  'persisted.workspaceSessionsByHostId': HOST_SESSION_SEED,
  // A move row, not a desktop rewrite: the host turns back on what the manifest carried disabled.
  'persisted.automations': WSL_MOVE_HOST_AUTOMATIONS_STORE_ID,
  'session.activeWorktreeId': SESSION_GLOBALS,
  'session.activeWorkspaceExecutionHostId': SESSION_GLOBALS,
  'session.activeWorkspaceKey': SESSION_GLOBALS,
  'ui.lastActiveWorktreeId': UI_ROUTING,
  'ui.manualRepoOrder': UI_ROUTING,
  'ui.explorerDisplayRootByWorktree': UI_ROUTING,
  'ui.showDotfilesByWorktree': UI_ROUTING,
  'ui.workspaceCleanup': UI_ROUTING,
  'ui.collapsedGroups': UI_ROUTING,
  // The scalar stays; the visible host list it resolves to gains the WSL host.
  'ui.workspaceHostScope': UI_ROUTING,
  'ui.workspaceHostOrder': UI_ROUTING,
  'ui.visibleWorkspaceHostIds': UI_ROUTING,
  'ui.agentsVisibleHostIds': UI_ROUTING,
  'ui.automationHostFilter': UI_ROUTING,
  'localStorage.src/renderer/src/lib/quick-open-file-history.ts': renderer('quick-open-history'),
  'localStorage.src/renderer/src/components/editor/ipynb-kernel-store.ts':
    renderer('notebook-environments'),
  'localStorage.src/renderer/src/components/editor/file-view-preference-storage.ts':
    renderer('file-view-preferences'),
  'sqlite.orchestration.worker_dispatches': WSL_MOVE_ORCHESTRATION_HISTORY_STORE_ID,
  'sqlite.orchestration.worker_terminal_resources': WSL_MOVE_ORCHESTRATION_HISTORY_STORE_ID,
  'outOfStore.orchestration.db': WSL_MOVE_ORCHESTRATION_HISTORY_STORE_ID,
  'outOfStore.browser partition (cookies, site storage)': WSL_MOVE_BROWSER_COOKIES_STORE_ID
}

const prefixed = (
  prefix: string,
  table: Record<string, WslMoveFieldDisposition>
): [string, WslMoveFieldDisposition][] =>
  Object.entries(table).map(([key, row]) => [`${prefix}.${key}`, row])

const ROWS = new Map<string, WslMoveFieldDisposition>([
  ...prefixed('persisted', PERSISTED_STATE_DISPOSITIONS),
  ...prefixed('session', WORKSPACE_SESSION_DISPOSITIONS),
  ...prefixed('ui', UI_STATE_DISPOSITIONS),
  ...prefixed('localStorage', LOCAL_STORAGE_MODULE_DISPOSITIONS),
  ...prefixed('sqlite', SQLITE_TABLE_DISPOSITIONS),
  ...OUT_OF_STORE_DISPOSITIONS.map((row): [string, WslMoveFieldDisposition] => [
    `outOfStore.${row.store}`,
    row
  ])
])

/** The stores startup registers, through the same entry point. */
function registeredStoreIds(): string[] {
  registerWslMoveDesktopRewriteRegistry({
    profile: {
      getUI: vi.fn(),
      updateUI: vi.fn(),
      getWorkspaceSession: vi.fn(),
      patchWorkspaceSession: vi.fn(),
      setWorkspaceSession: vi.fn(),
      flushPendingOrThrowAsync: vi.fn()
    },
    orchestrationDatabasePath: '/nowhere/orchestration.db',
    hostAutomations: { enable: vi.fn() },
    browserCookies: {
      userDataPath: '/nowhere',
      sessionsReady: () => false,
      orcaProfileId: () => null,
      listEnvironments: () => [],
      listBrowserProfiles: () => [],
      resolveHostStorage: vi.fn(),
      bindHostPartition: vi.fn(),
      copyCookies: vi.fn(),
      flushCookies: vi.fn()
    }
  })
  return listWslMoveDesktopRewriteStores().map((store) => store.id)
}

afterEach(() => {
  resetWslMoveDesktopRewriteStoresForTests()
})

describe('WSL move desktop rewrite registry coverage', () => {
  it('gives every desktop-rewrite disposition row a store', () => {
    const rewriteRows = [...ROWS]
      .filter(([, row]) => row.disposition === 'rewrite-desktop' || row.rewriteDesktopCopy)
      .map(([key]) => key)
    expect(rewriteRows.length).toBeGreaterThan(0)
    expect(rewriteRows.filter((key) => !Object.hasOwn(STORE_BY_ROW, key))).toEqual([])
  })

  it('names only rows the disposition tables have', () => {
    expect(Object.keys(STORE_BY_ROW).filter((key) => !ROWS.has(key))).toEqual([])
  })

  it('maps every registered store to a row, and registers every mapped store', () => {
    const registered = registeredStoreIds()
    const mapped = new Set(Object.values(STORE_BY_ROW))
    expect(registered.filter((id) => !mapped.has(id))).toEqual([])
    expect([...mapped].filter((id) => !registered.includes(id))).toEqual([])
  })

  it('is marked complete', () => {
    expect(WSL_MOVE_DESKTOP_REWRITE_REGISTRY_COMPLETE).toBe(true)
    expect(isWslMoveDesktopRewriteRegistryComplete()).toBe(true)
  })
})
