import { formatAgentTypeLabel } from '../../../src/shared/agent-type-label'
import type { CheckStatus } from '../../../src/shared/github/pull-request-types'
import type { HostedReviewInfo } from '../../../src/shared/hosted-review'
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

const PROVIDERS: readonly LinkProvider[] = [
  'github',
  'gitlab',
  'linear',
  'jira',
  'bitbucket',
  'azure-devops',
  'gitea'
]
const TYPES: readonly LinkType[] = ['issue', 'pr', 'mr']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isProvider(value: unknown): value is LinkProvider {
  return PROVIDERS.some((provider) => provider === value)
}

function isLinkType(value: unknown): value is LinkType {
  return TYPES.some((type) => type === value)
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

function referenceLabel(provider: LinkProvider, type: LinkType, number: number, key?: string) {
  if ((provider === 'linear' || provider === 'jira') && key) {
    return key
  }
  if (type === 'mr') {
    return `MR !${number}`
  }
  return type === 'pr' ? `PR #${number}` : `Issue #${number}`
}

function link(
  provider: LinkProvider,
  type: LinkType,
  ref: { number: number; key?: string },
  extra: Partial<WorkspaceDetailLink> = {}
): WorkspaceDetailLink {
  return {
    key: `${provider}:${type}:${ref.key ?? ref.number}`,
    provider,
    type,
    label: referenceLabel(provider, type, ref.number, ref.key),
    ...extra
  }
}

/** One `linkedItems` entry, or null for one this build cannot place (rows arrive unvalidated). */
function readAttachment(raw: unknown): WorkspaceDetailLink | null {
  if (!isRecord(raw) || !isProvider(raw.provider) || !isLinkType(raw.type)) {
    return null
  }
  const key =
    raw.provider === 'linear' || raw.provider === 'jira'
      ? (optionalText(raw.identifier) ??
        optionalText(raw.linearIdentifier) ??
        optionalText(raw.jiraIdentifier))
      : undefined
  const number = isPositiveNumber(raw.number) ? raw.number : 0
  if (!number && !key) {
    return null
  }
  return link(
    raw.provider,
    raw.type,
    { number, key },
    { title: optionalText(raw.title), url: webUrl(raw.url) }
  )
}

function reviewType(provider: LinkProvider): LinkType {
  return provider === 'gitlab' ? 'mr' : 'pr'
}

// Desktop hover card order: reviews, then hosted issues, then Linear, then Jira.
function linkRank(item: WorkspaceDetailLink): number {
  if (item.type !== 'issue') {
    return 0
  }
  return item.provider === 'linear' ? 2 : item.provider === 'jira' ? 3 : 1
}

/**
 * Every review and task linked to the row. `linkedItems` is the host's merged list; the singular
 * fields cover hosts that predate it and the branch's discovered PR, which is never an attachment.
 * `review` is the host's live lookup for the branch, which brings the title, link and checks.
 */
export function buildWorkspaceDetailLinks(
  row: Worktree,
  review?: HostedReviewInfo | null
): WorkspaceDetailLink[] {
  const pr = row.linkedPR
  const candidates = [
    ...(Array.isArray(row.linkedItems) ? row.linkedItems.map(readAttachment) : []),
    isPositiveNumber(pr?.number) ? link('github', 'pr', pr, { state: pr.state }) : null,
    isPositiveNumber(row.linkedGitLabMR)
      ? link('gitlab', 'mr', { number: row.linkedGitLabMR })
      : null,
    isPositiveNumber(row.linkedIssue) ? link('github', 'issue', { number: row.linkedIssue }) : null,
    isPositiveNumber(row.linkedGitLabIssue)
      ? link('gitlab', 'issue', { number: row.linkedGitLabIssue })
      : null,
    optionalText(row.linkedLinearIssue)
      ? link('linear', 'issue', { number: 0, key: optionalText(row.linkedLinearIssue) })
      : null
  ]
  const links = new Map<string, WorkspaceDetailLink>()
  for (const candidate of candidates) {
    if (!candidate) {
      continue
    }
    const known = links.get(candidate.key)
    // The same reference from two sources: keep the first, fill what it lacks.
    links.set(
      candidate.key,
      known
        ? {
            ...known,
            title: known.title ?? candidate.title,
            url: known.url ?? candidate.url,
            state: known.state ?? candidate.state
          }
        : candidate
    )
  }
  if (review && isProvider(review.provider) && isPositiveNumber(review.number)) {
    const live = link(review.provider, reviewType(review.provider), review)
    const known = links.get(live.key)
    links.set(live.key, {
      ...live,
      ...known,
      title: optionalText(review.title) ?? known?.title,
      url: webUrl(review.url) ?? known?.url,
      state: optionalText(review.state) ?? known?.state,
      checks: review.status
    })
  }
  // Stable sort keeps the host's own order within a rank.
  return [...links.values()].sort((a, b) => linkRank(a) - linkRank(b))
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
