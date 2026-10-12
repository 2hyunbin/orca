// The runtime's record of a workspace's client-hosted browser pages (design 2.3 transition
// "client-hosted browser page"), kept so a restart can still name pages a paired client hosts.

import type { PersistedClientHostedBrowserPage } from '../client-hosted-browser-page-record'
import { applied, type Applied } from './workspace-layout-command-steps'
import type { WorkspaceLayoutModel } from './workspace-layout-model'

/** Replaces one workspace's saved pages; an empty list drops its entry. */
export function saveClientHostedBrowserPages(
  model: WorkspaceLayoutModel,
  workspace: string,
  pages: readonly PersistedClientHostedBrowserPage[]
): Applied {
  const next = { ...model.records.clientHostedBrowserPagesByWorkspace }
  if (pages.length === 0) {
    delete next[workspace]
  } else {
    next[workspace] = [...pages]
  }
  return applied({
    ...model,
    records: { ...model.records, clientHostedBrowserPagesByWorkspace: next }
  })
}
