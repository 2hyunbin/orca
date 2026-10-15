import { describe, expect, it } from 'vitest'
import type { HostedReviewInfo } from '../../../src/shared/hosted-review'
import type { Worktree } from './workspace-list-types'
import {
  buildWorkspaceDetailLinks,
  buildWorkspaceOrigin,
  readWorkspaceDetailPorts,
  readWorkspaceOriginDetails,
  workspaceNotes
} from './workspace-details-model'

function row(overrides: Partial<Worktree> = {}): Worktree {
  return {
    worktreeId: 'repo::/src/app',
    repoId: 'repo',
    repo: 'orca',
    branch: 'feat/x',
    displayName: 'x',
    path: '/src/app',
    liveTerminalCount: 0,
    hasAttachedPty: false,
    unread: false,
    isPinned: false,
    linkedPR: null,
    ...overrides
  }
}

function review(overrides: Partial<HostedReviewInfo> = {}): HostedReviewInfo {
  return {
    provider: 'github',
    number: 12,
    title: 'Search keyboard',
    state: 'open',
    url: 'https://github.com/o/r/pull/12',
    status: 'success',
    updatedAt: '',
    mergeable: 'MERGEABLE',
    ...overrides
  }
}

describe('buildWorkspaceDetailLinks', () => {
  it('lists reviews first, then hosted issues, Linear and Jira, as the desktop hover card does', () => {
    const links = buildWorkspaceDetailLinks(
      row({
        linkedItems: [
          { provider: 'jira', type: 'issue', number: 0, identifier: 'ORCA-4', title: 'Jira one' },
          { provider: 'linear', type: 'issue', number: 0, identifier: 'ENG-7' },
          { provider: 'github', type: 'issue', number: 3, title: 'Bug', url: 'https://x/3' }
        ],
        linkedPR: { number: 12, state: 'open' }
      })
    )

    expect(links.map((link) => link.label)).toEqual(['PR #12', 'Issue #3', 'ENG-7', 'ORCA-4'])
    expect(links[0]).toMatchObject({ state: 'open' })
    expect(links[1]).toMatchObject({ title: 'Bug', url: 'https://x/3' })
  })

  it('reads the singular fields of a host that predates linkedItems', () => {
    const links = buildWorkspaceDetailLinks(
      row({ linkedIssue: 4, linkedGitLabMR: 9, linkedGitLabIssue: 2, linkedLinearIssue: 'ENG-1' })
    )

    expect(links.map((link) => `${link.provider} ${link.label}`)).toEqual([
      'gitlab MR !9',
      'github Issue #4',
      'gitlab Issue #2',
      'linear ENG-1'
    ])
  })

  it('lists a reference once when the attachments and a singular field both name it', () => {
    const links = buildWorkspaceDetailLinks(
      row({
        linkedItems: [{ provider: 'github', type: 'issue', number: 4, title: 'Bug' }],
        linkedIssue: 4
      })
    )

    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({ label: 'Issue #4', title: 'Bug' })
  })

  it("fills the row's PR in from the host's live branch review", () => {
    const [pr] = buildWorkspaceDetailLinks(
      row({ linkedPR: { number: 12, state: 'unknown' } }),
      review({ state: 'merged', status: 'failure' })
    )

    expect(pr).toMatchObject({
      label: 'PR #12',
      title: 'Search keyboard',
      url: 'https://github.com/o/r/pull/12',
      state: 'merged',
      checks: 'failure'
    })
  })

  it('names a GitLab review an MR', () => {
    const [mr] = buildWorkspaceDetailLinks(
      row({ linkedGitLabMR: 5 }),
      review({ provider: 'gitlab', number: 5 })
    )

    expect(mr).toMatchObject({ label: 'MR !5', title: 'Search keyboard' })
  })

  it('drops attachments this build cannot place and never opens a non-web link', () => {
    const links = buildWorkspaceDetailLinks(
      row({
        linkedItems: [
          'garbage',
          { provider: 'sourceforge', type: 'issue', number: 1 },
          { provider: 'github', type: 'issue', number: 0 },
          { provider: 'github', type: 'issue', number: 8, url: 'javascript:alert(1)' }
        ]
      })
    )

    expect(links).toEqual([expect.objectContaining({ label: 'Issue #8', url: undefined })])
  })
})

describe('workspace origin', () => {
  it('names the automation and its run once worktree.show answers', () => {
    const details = readWorkspaceOriginDetails({
      automationProvenance: {
        automationNameSnapshot: 'Nightly deps',
        automationRunTitleSnapshot: 'Run 3'
      }
    })

    expect(buildWorkspaceOrigin(row({ automationCreated: true }), details)).toEqual({
      kind: 'automation',
      name: 'Nightly deps',
      runTitle: 'Run 3'
    })
  })

  it("says only what the row's flag says until then", () => {
    expect(buildWorkspaceOrigin(row({ cliCreated: true }))).toEqual({ kind: 'cli' })
    expect(buildWorkspaceOrigin(row())).toBeNull()
  })

  it('tells an agent-run CLI create from a hand-typed one, and names the startup agent', () => {
    expect(
      readWorkspaceOriginDetails({
        cliProvenance: { callerTerminalHandle: 'term-1', startupAgent: 'claude' }
      })
    ).toEqual({ automation: undefined, cli: { fromAgent: true, startupAgent: 'Claude' } })
    expect(readWorkspaceOriginDetails({ cliProvenance: {} })?.cli).toEqual({
      fromAgent: false,
      startupAgent: undefined
    })
    expect(readWorkspaceOriginDetails({})).toBeNull()
  })
})

describe('readWorkspaceDetailPorts', () => {
  const port = (overrides: Record<string, unknown>) => ({
    id: 'p',
    kind: 'workspace',
    owner: { worktreeId: 'repo::/src/app' },
    bindHost: '0.0.0.0',
    connectHost: 'localhost',
    port: 5173,
    protocol: 'http',
    ...overrides
  })

  it("keeps only this workspace's listeners, copying the address the desktop copies", () => {
    const ports = readWorkspaceDetailPorts(
      {
        ports: [
          port({ id: 'a', processName: 'vite' }),
          port({ id: 'b', port: 3001, advertisedUrl: 'https://local.example.com:3001/' }),
          port({ id: 'c', connectHost: '::1', port: 8080 }),
          port({ id: 'd', owner: { worktreeId: 'other' } }),
          port({ id: 'e', kind: 'external' })
        ]
      },
      'repo::/src/app'
    )

    expect(ports).toEqual([
      { id: 'a', port: 5173, address: 'localhost:5173', processName: 'vite' },
      { id: 'b', port: 3001, address: 'local.example.com:3001', processName: undefined },
      { id: 'c', port: 8080, address: '[::1]:8080', processName: undefined }
    ])
  })

  it('answers unknown, not none, when the host could not scan', () => {
    expect(
      readWorkspaceDetailPorts({ ports: [], unavailableReason: 'SSH host not served' }, 'x')
    ).toBeNull()
    expect(readWorkspaceDetailPorts(null, 'x')).toBeNull()
    expect(readWorkspaceDetailPorts({ ports: [] }, 'x')).toEqual([])
  })
})

it('treats blank notes as none', () => {
  expect(workspaceNotes({ comment: '  \n ' })).toBeNull()
  expect(workspaceNotes({ comment: ' Check iPad ' })).toBe('Check iPad')
})
