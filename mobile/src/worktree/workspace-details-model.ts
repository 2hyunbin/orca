import { formatAgentTypeLabel } from '../../../src/shared/agent-type-label'
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
export type WorkspaceOrigin =
  | { kind: 'automation'; name?: string; runTitle?: string }
  | { kind: 'cli'; fromAgent?: boolean; startupAgent?: string }

/** The provenance `worktree.show` carries beyond the row's `automationCreated`/`cliCreated` flags. */
export type WorkspaceOriginDetails = {
  automation?: { name?: string; runTitle?: string }
  cli?: { fromAgent: boolean; startupAgent?: string }
}

export type WorkspaceDetailPort = {
  id: string
  port: number
  /** What Copy puts on the clipboard, as the desktop's: the printed origin's host, else host:port. */
  address: string
  processName?: string
}

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

/** The row's origin, filled in from `worktree.show` once it answers. */
export function buildWorkspaceOrigin(
  row: Worktree,
  details?: WorkspaceOriginDetails | null
): WorkspaceOrigin | null {
  if (row.automationCreated || details?.automation) {
    return { kind: 'automation', ...details?.automation }
  }
  if (row.cliCreated || details?.cli) {
    return { kind: 'cli', ...details?.cli }
  }
  return null
}

/** `worktree.show`'s provenance fields, or null when the record carries neither. */
export function readWorkspaceOriginDetails(worktree: unknown): WorkspaceOriginDetails | null {
  if (!isRecord(worktree)) {
    return null
  }
  const automation = isRecord(worktree.automationProvenance)
    ? {
        name: optionalText(worktree.automationProvenance.automationNameSnapshot),
        runTitle: optionalText(worktree.automationProvenance.automationRunTitleSnapshot)
      }
    : undefined
  const cliProvenance = isRecord(worktree.cliProvenance) ? worktree.cliProvenance : null
  const startupAgent = optionalText(cliProvenance?.startupAgent)
  const cli = cliProvenance
    ? {
        fromAgent: optionalText(cliProvenance.callerTerminalHandle) !== undefined,
        startupAgent: startupAgent ? formatAgentTypeLabel(startupAgent) : undefined
      }
    : undefined
  return automation || cli ? { automation, cli } : null
}

function portHost(connectHost: string | undefined): string {
  if (!connectHost) {
    return 'localhost'
  }
  return connectHost.includes(':') ? `[${connectHost}]` : connectHost
}

function advertisedHost(advertisedUrl: unknown): string | undefined {
  const url = webUrl(advertisedUrl)
  if (!url) {
    return undefined
  }
  try {
    return new URL(url).host || undefined
  } catch {
    return undefined
  }
}

/**
 * This workspace's listeners from a host-scoped port scan, or null when the host could not scan
 * (an SSH host this endpoint does not serve): an unknown answer is never "no ports".
 */
export function readWorkspaceDetailPorts(
  scan: unknown,
  worktreeId: string
): WorkspaceDetailPort[] | null {
  if (!isRecord(scan) || !Array.isArray(scan.ports) || optionalText(scan.unavailableReason)) {
    return null
  }
  return scan.ports.flatMap((port): WorkspaceDetailPort[] => {
    if (
      !isRecord(port) ||
      port.kind !== 'workspace' ||
      !isRecord(port.owner) ||
      port.owner.worktreeId !== worktreeId ||
      !isPositiveNumber(port.port)
    ) {
      return []
    }
    const address =
      advertisedHost(port.advertisedUrl) ??
      `${portHost(optionalText(port.connectHost))}:${port.port}`
    return [
      {
        id: optionalText(port.id) ?? address,
        port: port.port,
        address,
        processName: optionalText(port.processName)
      }
    ]
  })
}

export function workspaceNotes(row: Pick<Worktree, 'comment'>): string | null {
  return optionalText(row.comment) ?? null
}
