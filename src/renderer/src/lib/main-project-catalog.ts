import type { Repo } from '../../../shared/repo-types'
import type { SidebarFeedDomains } from '../../../shared/sidebar-list/sidebar-feed-domains'
import type { SidebarProjectCatalogRecords } from '../../../shared/sidebar-list/sidebar-project-catalog'
import {
  MAX_REPO_ICON_IDS_PER_READ,
  repoIconFeedKey
} from '../../../shared/sidebar-list/repo-icon-data-urls-contract'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../shared/sidebar-inputs-switch'
import { z } from 'zod'
import {
  onDesktopSidebarFeedInstalled,
  readDesktopSidebarFeed,
  refreshDesktopSidebarFeed,
  startDesktopSidebarFeed,
  type DesktopSidebarFeed
} from './desktop-sidebar-feed'

/** Main's catalog rows as the window holds them: uploaded icons joined back in. */
export type InstalledProjectCatalog = SidebarProjectCatalogRecords

type CatalogSink = (catalog: InstalledProjectCatalog) => void

const IconReplySchema = z.object({
  icons: z.array(z.object({ id: z.string(), dataUrl: z.string().nullable() }))
})

let sink: CatalogSink | null = null
let installedFrom: { records: SidebarProjectCatalogRecords; iconsSeen: number } | null = null
let installed: InstalledProjectCatalog | null = null
// Ids are content hashes, so a changed icon arrives as a new id; each is read once.
const iconDataUrls = new Map<string, string | null>()
const iconsAsked = new Set<string>()
let iconsAnswered = 0
const waiters = new Set<() => void>()

function withIcon(repo: Repo, iconIds: SidebarFeedDomains['repoIcons']): Repo {
  // Main sends an upload as null (its data URL is too large to resend); the image arrives by id.
  if (repo.repoIcon !== null) {
    return repo
  }
  const id = iconIds.get(repoIconFeedKey(repo))
  const dataUrl = id ? iconDataUrls.get(id) : undefined
  return dataUrl ? { ...repo, repoIcon: { type: 'image', source: 'upload', src: dataUrl } } : repo
}

function readMissingIcons(domains: SidebarFeedDomains): void {
  const wanted = [...new Set(domains.repoIcons.values())].filter((id) => !iconsAsked.has(id))
  for (let start = 0; start < wanted.length; start += MAX_REPO_ICON_IDS_PER_READ) {
    const ids = wanted.slice(start, start + MAX_REPO_ICON_IDS_PER_READ)
    ids.forEach((id) => iconsAsked.add(id))
    void window.api.runtime
      .call({ method: 'sidebarInputs.repoIcons', params: { ids } })
      .then((response) => {
        const reply = response.ok ? IconReplySchema.safeParse(response.result) : null
        if (!reply?.success) {
          ids.forEach((id) => iconsAsked.delete(id))
          return
        }
        reply.data.icons.forEach(({ id, dataUrl }) => iconDataUrls.set(id, dataUrl))
        iconsAnswered += 1
        const feed = readDesktopSidebarFeed()
        if (feed) {
          install(feed)
        }
      })
      .catch(() => ids.forEach((id) => iconsAsked.delete(id)))
  }
}

function install(feed: DesktopSidebarFeed): void {
  const records = feed.domains.catalogRecords
  if (!records) {
    return
  }
  readMissingIcons(feed.domains)
  if (installedFrom?.records !== records || installedFrom.iconsSeen !== iconsAnswered) {
    installedFrom = { records, iconsSeen: iconsAnswered }
    installed = {
      ...records,
      repos: records.repos.map((repo) => withIcon(repo, feed.domains.repoIcons))
    }
    sink?.(installed)
  }
  waiters.forEach((waiter) => waiter())
}

/** Switch point: main's catalog is the window's; `write` is its only writer. Call once. */
export function followMainProjectCatalog(write: CatalogSink): void {
  if (!ORCA_SIDEBAR_INPUTS_IS_MAIN || sink) {
    return
  }
  sink = write
  onDesktopSidebarFeedInstalled(install)
  startDesktopSidebarFeed()
  // The sidebar may have started the reader, and installed main's feed, before this follows it.
  const feed = readDesktopSidebarFeed()
  if (feed) {
    install(feed)
  }
}

function waitFor(done: () => boolean, timeoutMs: number): Promise<boolean> {
  if (done()) {
    return Promise.resolve(true)
  }
  return new Promise((resolve) => {
    const check = (): void => {
      if (done()) {
        waiters.delete(check)
        clearTimeout(timer)
        resolve(true)
      }
    }
    const timer = setTimeout(() => {
      waiters.delete(check)
      resolve(false)
    }, timeoutMs)
    waiters.add(check)
  })
}

// Main starting up can take a while to answer its first read; nothing is shown before it.
const FIRST_CATALOG_LIMIT_MS = 60_000
// A paired server's change reaches main's catalog only after that server announces it.
const REMOTE_WRITE_LIMIT_MS = 10_000

/** Resolves once main's catalog is installed (false if main never answers within the limit). */
export function awaitMainProjectCatalog(): Promise<boolean> {
  startDesktopSidebarFeed()
  return waitFor(() => installed !== null, FIRST_CATALOG_LIMIT_MS)
}

/**
 * After a catalog write main has answered: resolves once main's catalog shows it. A write main
 * made itself shows on the next read; `shows` waits for a paired server's to come back through main.
 */
export function awaitMainProjectCatalogWrite(
  shows?: (catalog: InstalledProjectCatalog) => boolean
): Promise<boolean> {
  if (!ORCA_SIDEBAR_INPUTS_IS_MAIN) {
    return Promise.resolve(true)
  }
  startDesktopSidebarFeed()
  const readId = refreshDesktopSidebarFeed()
  return waitFor(() => {
    const feed = readDesktopSidebarFeed()
    return (
      feed !== null &&
      feed.readId >= readId &&
      installed !== null &&
      (shows ? shows(installed) : true)
    )
  }, REMOTE_WRITE_LIMIT_MS)
}
