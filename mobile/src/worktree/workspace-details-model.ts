import type { CheckStatus } from '../../../src/shared/github/pull-request-types'
import { getWorkspaceAttachmentKey } from '../../../src/shared/workspace-attachment-normalization'
import {
  getWorkspaceAttachments,
  workspaceAttachmentReferenceLabel
} from '../../../src/shared/workspace-attachments'
import type { WorkspaceAttachment } from '../../../src/shared/worktree/types'
import type { Worktree } from './workspace-list-types'

/** A linked review or task as the long-press details list shows it. */
export type WorkspaceDetailLink = {
  key: string
  provider: WorkspaceAttachment['provider']
  type: WorkspaceAttachment['type']
  number: number
  /** `PR #12`, `MR !3`, `Issue #4`, or the tracker's own key (`ENG-12`). */
  label: string
  title?: string
  url?: string
  /** Review state (`open`, `merged`, ...); reviews only. */
  state?: string
  checks?: CheckStatus
}

/** Who made the workspace, as the desktop hover card's Automation / Orca CLI sections say. */
export type WorkspaceOrigin = { kind: 'automation'; name?: string } | { kind: 'cli' }

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

// Only web links leave the app; anything else on the wire is shown but not opened.
function webUrl(value: unknown): string | undefined {
  const url = optionalText(value)
  return url && /^https?:\/\//i.test(url) ? url : undefined
}

function toDetailLink(item: WorkspaceAttachment): WorkspaceDetailLink {
  return {
    key: getWorkspaceAttachmentKey(item),
    provider: item.provider,
    type: item.type,
    number: item.number,
    label: workspaceAttachmentReferenceLabel(item),
    title: optionalText(item.title),
    url: webUrl(item.url)
  }
}

/**
 * Every review and task linked to the row, read the way the desktop hover card reads them: the
 * host's `linkedItems`, then the singular fields older hosts send. The branch's PR is the row's
 * `linkedPR`, so it carries the same state as the row's badge, and the title, link and checks
 * when the host sends them. Reviews come first, as in the desktop's list.
 */
export function buildWorkspaceDetailLinks(row: Worktree): WorkspaceDetailLink[] {
  const pr = row.linkedPR
  const links = getWorkspaceAttachments({
    // Rows arrive unvalidated; the shared reader drops entries it cannot place.
    linkedItems: Array.isArray(row.linkedItems) ? row.linkedItems : undefined,
    linkedPR: pr?.number ?? null,
    linkedIssue: row.linkedIssue ?? null,
    linkedGitLabMR: row.linkedGitLabMR ?? null,
    linkedGitLabIssue: row.linkedGitLabIssue ?? null,
    linkedLinearIssue: optionalText(row.linkedLinearIssue) ?? null
  }).map((item): WorkspaceDetailLink => {
    const link = toDetailLink(item)
    const isBranchPR =
      pr && link.provider === 'github' && link.type === 'pr' && link.number === pr.number
    return isBranchPR
      ? {
          ...link,
          title: optionalText(pr.title) ?? link.title,
          url: webUrl(pr.url) ?? link.url,
          state: pr.state,
          checks: pr.checksStatus
        }
      : link
  })
  // Stable: the host's own order holds within reviews and within tasks.
  return links.sort((a, b) => Number(a.type === 'issue') - Number(b.type === 'issue'))
}

export function buildWorkspaceOrigin(row: Worktree): WorkspaceOrigin | null {
  if (row.automationCreated) {
    // Older hosts send only the flag, so the name is optional.
    const name = optionalText(row.automationName)
    return name ? { kind: 'automation', name } : { kind: 'automation' }
  }
  return row.cliCreated ? { kind: 'cli' } : null
}

export function workspaceNotes(row: Pick<Worktree, 'comment'>): string | null {
  return optionalText(row.comment) ?? null
}
