import { describe, expect, it } from 'vitest'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import { getDefaultNotificationSettings } from '../../shared/notification-settings-defaults'
import type { PersistedState } from '../../shared/persisted-state-types'
import type { Worktree } from '../../shared/worktree/types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { WorktreeLineage } from '../../shared/worktree/lineage-types'
import {
  isStructuredAttentionWorkspaceHidden,
  type HiddenWorkspaceAttentionDeps
} from './structured-attention-hidden-workspace'

const WORKSPACE_ID = 'repo-1::/work/feature'
const SCOPE: AgentSessionExecutionLocation = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: WORKSPACE_ID,
  workspaceKind: 'git-worktree'
}

function listed(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: WORKSPACE_ID,
    repoId: 'repo-1',
    path: '/work/feature',
    head: 'abc1234',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false,
    displayName: 'feature',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

function deps(options: {
  ui?: Partial<PersistedState['ui']> | null
  notifyHiddenWorkspaces?: boolean
  resolved?: Worktree[] | null
  meta?: Partial<WorktreeMeta>
  lineage?: Record<string, Pick<WorktreeLineage, 'parentWorktreeId'>>
}): HiddenWorkspaceAttentionDeps {
  return {
    store: {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the check reads only the hide* switches of this partial UI.
      getUI: () => (options.ui === null ? undefined : options.ui) as PersistedState['ui'],
      getRepo: () => undefined,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the check reads only provenance fields of this partial meta.
      getWorktreeMeta: () => options.meta as WorktreeMeta | undefined,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the check reads only parentWorktreeId.
      getAllWorktreeLineage: () => (options.lineage ?? {}) as Record<string, WorktreeLineage>
    },
    notificationSettings: {
      ...getDefaultNotificationSettings(),
      notifyHiddenWorkspaces: options.notifyHiddenWorkspaces ?? false
    },
    resolvedWorktrees: options.resolved === undefined ? [listed()] : options.resolved
  }
}

const CLI_META: Partial<WorktreeMeta> = { cliProvenance: { kind: 'created-by-cli', createdAt: 0 } }

describe('isStructuredAttentionWorkspaceHidden', () => {
  it('hides a CLI-created workspace from its provenance even with no Git listing', () => {
    expect(
      isStructuredAttentionWorkspaceHidden(
        deps({ ui: { hideCliCreatedWorkspaces: true }, resolved: null, meta: CLI_META }),
        SCOPE
      )
    ).toBe(true)
  })

  it('hides an automation-created, default-branch or detached-HEAD workspace by its switch', () => {
    const automation: Partial<WorktreeMeta> = {
      automationProvenance: {
        kind: 'created-by-automation',
        automationId: 'a',
        automationNameSnapshot: 'a',
        automationRunId: 'r',
        automationRunTitleSnapshot: 'r',
        createdAt: 0,
        executionTargetType: 'local',
        executionTargetId: 'local',
        projectId: 'p'
      }
    }
    expect(
      isStructuredAttentionWorkspaceHidden(
        deps({ ui: { hideAutomationGeneratedWorkspaces: true }, meta: automation }),
        SCOPE
      )
    ).toBe(true)
    expect(
      isStructuredAttentionWorkspaceHidden(
        deps({
          ui: { hideDefaultBranchWorkspace: true },
          resolved: [listed({ isMainWorktree: true, branch: 'refs/heads/main' })]
        }),
        SCOPE
      )
    ).toBe(true)
    expect(
      isStructuredAttentionWorkspaceHidden(
        deps({ ui: { hideDetachedHeadWorkspaces: true }, resolved: [listed({ branch: '' })] }),
        SCOPE
      )
    ).toBe(true)
  })

  it('notifies when the setting is on, no switch matches, or the switch is off', () => {
    const on = { hideCliCreatedWorkspaces: true }
    expect(
      isStructuredAttentionWorkspaceHidden(
        deps({ ui: on, meta: CLI_META, notifyHiddenWorkspaces: true }),
        SCOPE
      )
    ).toBe(false)
    expect(isStructuredAttentionWorkspaceHidden(deps({ ui: on }), SCOPE)).toBe(false)
    expect(isStructuredAttentionWorkspaceHidden(deps({ ui: {}, meta: CLI_META }), SCOPE)).toBe(
      false
    )
  })

  it('fails open without persisted UI, a workspace record, or for a folder or lineage parent', () => {
    const on = { hideCliCreatedWorkspaces: true }
    expect(isStructuredAttentionWorkspaceHidden(deps({ ui: null, meta: CLI_META }), SCOPE)).toBe(
      false
    )
    expect(isStructuredAttentionWorkspaceHidden(deps({ ui: on, resolved: null }), SCOPE)).toBe(
      false
    )
    expect(
      isStructuredAttentionWorkspaceHidden(deps({ ui: on, meta: CLI_META }), {
        ...SCOPE,
        workspaceKind: 'folder'
      })
    ).toBe(false)
    expect(
      isStructuredAttentionWorkspaceHidden(
        deps({ ui: on, meta: CLI_META, lineage: { child: { parentWorktreeId: WORKSPACE_ID } } }),
        SCOPE
      )
    ).toBe(false)
  })
})
