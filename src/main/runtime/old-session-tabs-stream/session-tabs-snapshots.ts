// Today's `session.tabs.*` snapshot for old phones, old desktops and paired web clients, built on
// read from the holder's model (design 2.6): the phone list is a projection, never a cache. Only
// the old stream's own fields live here: the boot epoch, each worktree's version, the retirement
// proofs and today's notify coalescer.

import { randomUUID } from 'node:crypto'
import type {
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabsSnapshot
} from '../../../shared/runtime-types'
import { projectSessionTabs } from '../../../shared/workspace-layout/old-client'
import type { WorkspaceLayoutEvent } from '../../../shared/workspace-layout/workspace-layout-stream-frames'
import type { LayoutViewContentFacts } from '../runtime-layout-views'
import type { RuntimeWorkspaceLayouts } from '../runtime-workspace-layouts'
import { createMobileSessionTabsNotifyCoalescer } from './session-tabs-notify-coalescer'
import { SessionTabsRetirementProofs, type IssuedHandleOf } from './session-tabs-retirement-proofs'

export type OldSessionTabsStreamDeps = {
  holder: Pick<RuntimeWorkspaceLayouts, 'subscribe' | 'hostIdOf' | 'model' | 'beside'>
  /** What the desktop view reports for phones: the terminal theme and launch drafts. */
  contentFacts: () => LayoutViewContentFacts
  generatedTitlesEnabled: () => boolean
  issuedHandleOf: IssuedHandleOf
  /** The holder published or removed a worktree: the runtime emits its snapshot now. */
  changed: (worktreeId: string, removed: boolean) => void
  /** A coalesced change settled: the runtime emits the worktree's latest snapshot. */
  flush: (worktreeId: string) => void
}

export class OldSessionTabsStream {
  /** One publisher per process: versions order every snapshot within it. */
  readonly publicationEpoch = `layout:${randomUUID()}`
  private nextVersion = 1
  private readonly versions = new Map<string, number>()
  private readonly keys = new Set<string>()
  private readonly proofs: SessionTabsRetirementProofs
  readonly coalescer: ReturnType<typeof createMobileSessionTabsNotifyCoalescer>

  constructor(private readonly deps: OldSessionTabsStreamDeps) {
    this.proofs = new SessionTabsRetirementProofs(deps.issuedHandleOf)
    this.coalescer = createMobileSessionTabsNotifyCoalescer(deps.flush)
    const { snapshot } = deps.holder.subscribe((event) => this.published(event))
    for (const { key, layout } of snapshot) {
      this.keys.add(key)
      this.proofs.published(key, layout)
    }
  }

  worktreeIds(): string[] {
    return [...this.keys]
  }

  has(worktreeId: string): boolean {
    return this.keys.has(worktreeId)
  }

  /** Something a snapshot shows changed (layout, a terminal, a title, agent status). */
  bump(worktreeId: string): void {
    this.versions.set(worktreeId, this.nextVersion++)
  }

  snapshot(worktreeId: string): RuntimeMobileSessionTabsSnapshot | null {
    if (!this.keys.has(worktreeId)) {
      return null
    }
    const hostId = this.deps.holder.hostIdOf(worktreeId)
    const workspace = hostId ? this.deps.holder.model(hostId)?.workspaces[worktreeId] : undefined
    const beside = hostId ? this.deps.holder.beside(hostId) : undefined
    const stamps = {
      publicationEpoch: this.publicationEpoch,
      snapshotVersion: this.versions.get(worktreeId) ?? 0,
      ...(this.proofs.of(worktreeId) ? { retiredTerminalSurfaces: this.proofs.of(worktreeId) } : {})
    }
    if (!workspace || !beside) {
      return {
        worktree: worktreeId,
        ...stamps,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabs: []
      }
    }
    const projected = projectSessionTabs(
      worktreeId,
      workspace,
      beside.desktopView,
      beside.facts,
      this.deps.generatedTitlesEnabled()
    )
    const contentFacts = this.deps.contentFacts()
    const tabs = projected.tabs.map((row): RuntimeMobileSessionSnapshotTab => {
      if (row.type !== 'terminal') {
        return row
      }
      const draft = contentFacts.launchDrafts?.[row.parentTabId]
      return {
        ...row,
        ...(contentFacts.terminalTheme ? { terminalTheme: contentFacts.terminalTheme } : {}),
        ...(draft ? { launchDraft: draft.text, launchDraftCreatedAt: draft.createdAt } : {})
      }
    })
    return { ...projected, ...stamps, tabs }
  }

  private published(event: WorkspaceLayoutEvent): void {
    const removed = event.type === 'removed'
    if (removed) {
      this.keys.delete(event.key)
      this.versions.delete(event.key)
      this.coalescer.cancel(event.key)
    } else {
      this.keys.add(event.key)
      this.bump(event.key)
    }
    this.proofs.published(event.key, removed ? null : event.layout)
    this.deps.changed(event.key, removed)
  }
}
