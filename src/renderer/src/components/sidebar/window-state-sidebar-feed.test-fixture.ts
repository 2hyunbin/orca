import type { AppState } from '@/store/types'
import type { DesktopSidebarFeed } from '@/lib/desktop-sidebar-feed'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import {
  readSidebarFeedDomains,
  type SidebarFeedRead
} from '../../../../shared/sidebar-list/sidebar-feed-domains'
import type { InstalledSidebarInputs } from '../../../../shared/sidebar-list/sidebar-inputs-feed-installer'
import { feedDomainsFromWindowState } from './sidebar-list-parity.test-fixture'

// Fields a card test's partial store may omit that main's producers read.
const PRODUCER_DEFAULTS = {
  agentStatusByPaneKey: {},
  browserTabsByWorktree: {},
  folderWorkspaces: [],
  pendingWorktreeCreations: {},
  prCache: {},
  projectGroups: [],
  ptyIdsByTabId: {},
  repos: [],
  runtimeEnvironments: [],
  runtimeStatusByEnvironmentId: new Map(),
  sshConnectionStates: new Map(),
  sshTargetLabels: new Map(),
  tabsByWorktree: {},
  unifiedTabsByWorktree: {},
  worktreeLineageById: {},
  workspaceHostOrder: [],
  worktreesByRepo: {},
  wslHostStatuses: {}
}

type InstalledFeed = { json: Map<string, string>; read: SidebarFeedRead; feed: DesktopSidebarFeed }

let last: InstalledFeed | null = null

/**
 * Main's feed for this store, installed as the desktop window installs it. As main publishes only
 * what changed, an unchanged domain keeps its identity and an unchanged store keeps the feed.
 */
export function sidebarFeedFromWindowState(state: Partial<AppState>): DesktopSidebarFeed {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: PRODUCER_DEFAULTS fills every field the feed producers read that a partial test store omits.
  const full = { ...PRODUCER_DEFAULTS, ...state } as unknown as AppState
  // Every server the window knows is paired, so main reads its rows from that server.
  const serverHostIds = new Set(
    full.runtimeEnvironments.map((environment) => toRuntimeExecutionHostId(environment.id))
  )
  const json = new Map(
    feedDomainsFromWindowState(full, serverHostIds)
      // The window lists from its own catalog; main's (read async from servers) is the phone's.
      .filter((domain) => domain.name !== 'projectCatalog')
      .map((domain) => {
        const entities = domain.read()
        if (entities instanceof Promise) {
          throw new Error(`domain ${domain.name} read asynchronously`)
        }
        return [domain.name, JSON.stringify(entities)]
      })
  )
  const previous = last
  if (previous && [...json].every(([name, text]) => previous.json.get(name) === text)) {
    return previous.feed
  }
  const installed: InstalledSidebarInputs = {
    generation: 'window-state',
    revision: (previous?.read.installed.revision ?? 0) + 1,
    schemaVersion: 1,
    semanticsVersion: 1,
    domains: new Map(
      [...json].map(([name, text]) => [
        name,
        previous?.json.get(name) === text
          ? (previous.read.installed.domains.get(name) ?? new Map())
          : // The wire's JSON round trip, so entities match what the window installs.
            new Map(Object.entries(JSON.parse(text)))
      ])
    )
  }
  const read = { installed, domains: readSidebarFeedDomains(installed, previous?.read) }
  const feed = { domains: read.domains, readId: installed.revision }
  last = { json, read, feed }
  return feed
}

/** A '@/lib/desktop-sidebar-feed' mock whose feed follows the test's store state. */
export function createWindowStateSidebarFeedModuleMock(
  readState: () => object
): Record<string, unknown> {
  return {
    useDesktopSidebarFeed: () => sidebarFeedFromWindowState(readState()),
    onDesktopSidebarFeedInstalled: () => () => {},
    refreshDesktopSidebarFeed: () => 0
  }
}
