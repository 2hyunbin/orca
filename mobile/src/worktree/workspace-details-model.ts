import type { CheckStatus } from '../../../src/shared/github/pull-request-types'
import type { HostedReviewInfo } from '../../../src/shared/hosted-review'
import { getWorkspaceAttachmentKey } from '../../../src/shared/workspace-attachment-normalization'
import { getWorkspaceAttachments } from '../../../src/shared/workspace-attachments'
import type { WorkspaceAttachment } from '../../../src/shared/worktree/types'
import type { Worktree } from './workspace-list-types'

type LinkProvider = WorkspaceAttachment['provider']
type LinkType = WorkspaceAttachment['type']

/** A linked review or task as the long-press details list shows it. */
export type WorkspaceDetailLink = {
  key: string
  provider: LinkProvider
  type: LinkType
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

/** What `worktree.show` adds to the row's `automationCreated` flag: the automation's name. */
export type WorkspaceOriginDetails = { automationName?: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

// Only web links leave the app; anything else on the wire is shown but not opened.
function webUrl(value: unknown): string | undefined {
  const url = optionalText(value)
  return url && /^https?:\/\//i.test(url) ? url : undefined
}

function referenceLabel(item: WorkspaceAttachment): string {
  if (item.provider === 'linear' || item.provider === 'jira') {
    const key = item.identifier ?? item.linearIdentifier ?? item.jiraIdentifier
    if (key) {
      return key
    }
  }
  if (item.type === 'mr') {
    return `MR !${item.number}`
  }
  return item.type === 'pr' ? `PR #${item.number}` : `Issue #${item.number}`
}

function toDetailLink(item: WorkspaceAttachment): WorkspaceDetailLink {
  return {
    key: getWorkspaceAttachmentKey(item),
    provider: item.provider,
    type: item.type,
    label: referenceLabel(item),
    title: optionalText(item.title),
    url: webUrl(item.url)
  }
}

function isReviewOf(link: WorkspaceDetailLink, review: HostedReviewInfo): boolean {
  return (
    link.type !== 'issue' &&
    link.provider === review.provider &&
    link.label ===
      referenceLabel({ provider: link.provider, type: link.type, number: review.number }) &&
    (!link.url || !review.url || link.url === review.url)
  )
}

/**
 * Every review and task linked to the row, read the way the desktop hover card reads them
 * (getWorkspaceAttachments: the host's list, then the singular fields older hosts send), plus the
 * branch's discovered PR, which is never an attachment. `review` is the host's live lookup for the
 * branch, which brings the title, link and checks. Reviews come first, as the desktop's list does.
 */
export function buildWorkspaceDetailLinks(
  row: Worktree,
  review?: HostedReviewInfo | null
): WorkspaceDetailLink[] {
  const links = getWorkspaceAttachments({
    // Rows arrive unvalidated; the shared reader drops entries it cannot place.
    linkedItems: Array.isArray(row.linkedItems) ? row.linkedItems : undefined,
    linkedPR: isPositiveNumber(row.linkedPR?.number) ? row.linkedPR.number : null,
    linkedIssue: row.linkedIssue ?? null,
    linkedGitLabMR: row.linkedGitLabMR ?? null,
    linkedGitLabIssue: row.linkedGitLabIssue ?? null,
    linkedLinearIssue: optionalText(row.linkedLinearIssue) ?? null
  }).map(toDetailLink)
  const branchPR = links.find(
    (link) =>
      link.provider === 'github' &&
      link.type === 'pr' &&
      link.label === `PR #${row.linkedPR?.number}`
  )
  if (branchPR && row.linkedPR) {
    branchPR.state = row.linkedPR.state
  }
  const provider = review?.provider
  if (review && provider && provider !== 'unsupported' && isPositiveNumber(review.number)) {
    const known = links.find((link) => isReviewOf(link, review))
    const live: WorkspaceDetailLink = {
      ...(known ??
        toDetailLink({
          provider,
          type: provider === 'gitlab' ? 'mr' : 'pr',
          number: review.number
        })),
      title: optionalText(review.title) ?? known?.title,
      url: webUrl(review.url) ?? known?.url,
      state: optionalText(review.state) ?? known?.state,
      checks: review.status
    }
    if (known) {
      links[links.indexOf(known)] = live
    } else {
      links.unshift(live)
    }
  }
  // Stable: the host's own order holds within reviews and within tasks.
  return links.sort((a, b) => Number(a.type === 'issue') - Number(b.type === 'issue'))
}

/** The row's origin, the automation named once `worktree.show` answers. */
export function buildWorkspaceOrigin(
  row: Worktree,
  details?: WorkspaceOriginDetails | null
): WorkspaceOrigin | null {
  if (row.automationCreated || details?.automationName) {
    return details?.automationName
      ? { kind: 'automation', name: details.automationName }
      : { kind: 'automation' }
  }
  return row.cliCreated ? { kind: 'cli' } : null
}

/** The automation `worktree.show` names on the record, or null when it names none. */
export function readWorkspaceOriginDetails(worktree: unknown): WorkspaceOriginDetails | null {
  const automationName =
    isRecord(worktree) && isRecord(worktree.automationProvenance)
      ? optionalText(worktree.automationProvenance.automationNameSnapshot)
      : undefined
  return automationName ? { automationName } : null
}

export function workspaceNotes(row: Pick<Worktree, 'comment'>): string | null {
  return optionalText(row.comment) ?? null
}
