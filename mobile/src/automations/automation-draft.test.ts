import { loadAutomationTargets, automationSetupKey } from './automation-target-inventory'
import { describe, expect, it } from 'vitest'
import {
  AutomationCreate,
  AutomationUpdate
} from '../../../src/shared/rpc-contract/automation-params'
import { automationListSchema } from './automation-reply-schema'
import {
  automationCreateParams,
  automationUpdateParams,
  newAutomationDraft
} from './automation-draft'
import { automationClient, automationTargets, savedAutomation } from './automation-test-fixtures'

describe('mobile automation host contracts', () => {
  it('keeps target host identity and expands the managed inventory past the initial range', async () => {
    const base = automationTargets().setups[0]!
    const setups = [base, { ...base, hostId: 'ssh:builder' as const }]
    const worktrees = Array.from({ length: 202 }, (_, i) => ({
      id: `repo-1::/repo/${i}`,
      repoId: 'repo-1',
      path: `/repo/${i}`,
      displayName: `Workspace ${i}`,
      hostId: 'ssh:builder'
    }))
    const port = automationClient((method, params) => {
      if (method === 'project.list') {
        return { projects: [{ id: base.projectId, displayName: 'Project' }] }
      }
      if (method === 'projectHostSetup.list') {
        return { setups }
      }
      if (method === 'repo.list') {
        return [
          { id: base.repoId, displayName: 'Local', path: base.path },
          { id: base.repoId, displayName: 'SSH', path: base.path, connectionId: 'builder' }
        ]
      }
      if (method === 'ssh.listTargetSummaries') {
        return { targets: [{ id: 'builder', label: 'Builder', generation: 7 }] }
      }
      if (method === 'worktree.list') {
        const limit =
          params &&
          typeof params === 'object' &&
          'limit' in params &&
          typeof params.limit === 'number'
            ? params.limit
            : 200
        return {
          worktrees: worktrees.slice(0, limit),
          totalCount: worktrees.length,
          truncated: limit < worktrees.length,
          hostScope: { hostIds: ['ssh:builder'], omittedHostIds: ['local'] }
        }
      }
      throw new Error(`Unexpected method: ${method}`)
    })
    const initial = await loadAutomationTargets(port.client)
    expect(initial.setups).toHaveLength(2)
    expect(initial.coverage).toMatchObject({
      totalCount: 202,
      truncated: true,
      hostScope: { omittedHostIds: ['local'] }
    })
    const complete = await loadAutomationTargets(port.client, initial.coverage.totalCount)
    expect(complete.workspaces).toHaveLength(202)
    const selected = complete.setups.find((setup) => setup.hostId === 'ssh:builder')!
    const draft = {
      ...newAutomationDraft(),
      name: 'SSH',
      prompt: 'Review',
      agentId: 'codex' as const,
      setupId: automationSetupKey(selected),
      workspaceMode: 'existing' as const,
      workspaceId: complete.workspaces[201]!.worktreeId
    }
    expect(automationCreateParams(draft, complete)).toMatchObject({
      runContext: { hostId: 'ssh:builder', path: '/repo' },
      workspace: 'id:repo-1::/repo/201',
      destination: { selector: { kind: 'ssh', targetId: 'builder', targetGeneration: 7 } }
    })
  })

  it('creates enabled using real host selectors and a captured setup', () => {
    const draft = {
      ...newAutomationDraft(),
      name: 'Daily review',
      prompt: 'Review changes',
      agentId: 'codex' as const,
      setupId: automationSetupKey(automationTargets().setups[0]!),
      workspaceMode: 'existing' as const,
      workspaceId: 'workspace-1'
    }
    const params = AutomationCreate.parse(
      automationCreateParams(draft, automationTargets(), 'creation-1')
    )
    expect(params).toMatchObject({
      enabled: true,
      repo: 'id:repo-1',
      workspace: 'id:workspace-1',
      creationKey: 'creation-1',
      destination: { selector: { kind: 'self' } },
      runContext: {
        projectId: 'project-1',
        projectHostSetupId: 'setup-1',
        repoId: 'repo-1',
        path: '/repo'
      }
    })
    expect(params.baseBranch).toBeUndefined()
  })
  it('edits only changed fields, preserving paused/custom/advanced and future host values', () => {
    const saved = savedAutomation()
    const original = newAutomationDraft(saved)
    const params = automationUpdateParams(
      saved.id,
      { ...original, name: 'Renamed' },
      original,
      automationTargets()
    )
    expect(AutomationUpdate.parse(params)).toMatchObject({
      id: saved.id,
      updates: { name: 'Renamed' }
    })
    expect(params.updates).toEqual({ name: 'Renamed' })
    expect(params.destination).toBeUndefined()
    expect(original).toMatchObject({
      agentId: 'codex',
      rrule: saved.rrule,
      grace: '0',
      reuseSession: true
    })
  })
  it('refuses missing or duplicate owners instead of attributing rows to this host', () => {
    const automations = [savedAutomation()]
    const item = { automationId: automations[0]!.id, selector: { kind: 'self' } }
    expect(automationListSchema.safeParse({ automations }).success).toBe(false)
    expect(automationListSchema.safeParse({ automations, items: [] }).success).toBe(false)
    expect(automationListSchema.safeParse({ automations, items: [item, item] }).success).toBe(false)
    expect(
      automationListSchema.parse({ automations, items: [item] })[0]?.automation.futureField
    ).toBe('keep me')
  })
})
