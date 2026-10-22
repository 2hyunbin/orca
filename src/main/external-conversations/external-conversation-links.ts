import { z } from 'zod'
import {
  CONNECTOR_SOURCES,
  type ExternalConversationLink
} from '../../shared/external-conversation-link'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'
import { folderWorkspaceKey } from '../../shared/workspace-scope'
import type { AgentPaneWorkspace } from '../agent-hooks/agent-transition-detector'
import {
  readWorkspaceRecord,
  writeWorkspaceRecord,
  type WorkspaceRecordStore
} from '../runtime/sidebar-inputs/sort-stamp-records'
import { CONNECTOR_AGENTS } from './connector-agents'
import { conversationId, type ConversationKey } from './external-conversation-types'

type LinkRecord = { externalConversations?: unknown }

/** The workspace records links live on; the runtime's store satisfies it. */
export type ExternalConversationLinkStore = WorkspaceRecordStore<
  LinkRecord,
  { externalConversations: ExternalConversationLink[] }
> & {
  getAllWorktreeMeta: () => Record<string, LinkRecord & { hostId?: ExecutionHostId }>
  getFolderWorkspaces?: () => readonly (LinkRecord & { id: string })[]
}

export type LinkedConversation = { workspace: AgentPaneWorkspace; link: ExternalConversationLink }

const ExternalConversationLinkSchema = z.object({
  source: z.enum(CONNECTOR_SOURCES),
  externalId: z.string(),
  paneKey: z.string(),
  agent: z.enum(CONNECTOR_AGENTS),
  createdAt: z.number()
})

/** The workspace record's links; malformed entries (hand edits, a newer host's shape) are skipped. */
export function readLinks(
  store: ExternalConversationLinkStore,
  workspace: AgentPaneWorkspace
): ExternalConversationLink[] {
  const record = readWorkspaceRecord(store, workspace)
  return linksOf(record?.externalConversations)
}

function linksOf(value: unknown): ExternalConversationLink[] {
  const entries: unknown[] = Array.isArray(value) ? value : []
  return entries.flatMap((entry) => {
    const parsed = ExternalConversationLinkSchema.safeParse(entry)
    return parsed.success ? [parsed.data] : []
  })
}

function sameConversation(link: ExternalConversationLink, key: ConversationKey): boolean {
  return link.source === key.source && link.externalId === key.externalId
}

/** Replaces this conversation's link on the workspace record, host-qualified like any meta write. */
export function writeLink(
  store: ExternalConversationLinkStore,
  workspace: AgentPaneWorkspace,
  link: ExternalConversationLink
): void {
  const others = readLinks(store, workspace).filter((existing) => !sameConversation(existing, link))
  writeWorkspaceRecord(store, workspace, { externalConversations: [...others, link] })
  // The record writer skips a workspace whose host it cannot name rather than guess.
  if (!readLinks(store, workspace).some((current) => current.paneKey === link.paneKey)) {
    throw new Error('external_conversation_link_unwritten')
  }
}

/**
 * The derived `conversation → link` and `pane → link` lookups. Every answer is confirmed against
 * the workspace record, and a stale or missing entry rebuilds once, so a removed, renamed or
 * re-adopted workspace is never answered from the cache. Writers and workspace lifecycle events
 * also invalidate it so the pane lookup sees new links.
 */
export class ExternalConversationIndex {
  private byConversation: Map<string, LinkedConversation> | null = null
  private byPane = new Map<string, LinkedConversation>()

  constructor(private readonly store: ExternalConversationLinkStore) {}

  invalidate(): void {
    this.byConversation = null
  }

  lookup(key: ConversationKey): LinkedConversation | null {
    return this.confirmed(() => this.index().get(conversationId(key)))
  }

  lookupPane(paneKey: string): LinkedConversation | null {
    return this.confirmed(() => {
      this.index()
      return this.byPane.get(paneKey)
    })
  }

  private confirmed(read: () => LinkedConversation | undefined): LinkedConversation | null {
    const cached = read()
    if (cached && this.confirm(cached)) {
      return cached
    }
    this.invalidate()
    const rebuilt = read()
    return rebuilt && this.confirm(rebuilt) ? rebuilt : null
  }

  private confirm({ workspace, link }: LinkedConversation): boolean {
    return readLinks(this.store, workspace).some(
      (current) => sameConversation(current, link) && current.paneKey === link.paneKey
    )
  }

  private index(): Map<string, LinkedConversation> {
    if (this.byConversation) {
      return this.byConversation
    }
    const byConversation = new Map<string, LinkedConversation>()
    const byPane = new Map<string, LinkedConversation>()
    const add = (workspace: AgentPaneWorkspace, links: unknown): void => {
      for (const link of linksOf(links)) {
        const linked = { workspace, link }
        byConversation.set(conversationId(link), linked)
        byPane.set(link.paneKey, linked)
      }
    }
    for (const [worktreeId, meta] of Object.entries(this.store.getAllWorktreeMeta())) {
      const hostId = meta.hostId && meta.hostId !== LOCAL_EXECUTION_HOST_ID ? meta.hostId : null
      add({ worktreeId, sshHostId: hostId }, meta.externalConversations)
    }
    for (const folder of this.store.getFolderWorkspaces?.() ?? []) {
      add(
        { worktreeId: folderWorkspaceKey(folder.id), sshHostId: null },
        folder.externalConversations
      )
    }
    this.byConversation = byConversation
    this.byPane = byPane
    return byConversation
  }
}
