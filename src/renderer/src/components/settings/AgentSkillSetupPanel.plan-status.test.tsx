// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { planEntry, planOf, planOp } from '../skills/bundled-skill-plan-fixtures.test-support'
import { AgentSkillSetupPanel } from './AgentSkillSetupPanel'

const mocks = vi.hoisted(() => ({ plan: vi.fn() }))
const TARGET = { kind: 'environment', environmentId: 'agents-host' } as const
vi.mock('@/hooks/useActiveProjectSkillRuntime', () => ({
  useActiveProjectSkillRuntime: () => ({ bundledSkillTarget: TARGET })
}))
vi.mock('@/runtime/runtime-bundled-skills-client', () => ({
  planBundledSkillsOnTarget: mocks.plan,
  executeBundledSkillsOnTarget: vi.fn()
}))
vi.mock('@/hooks/installed-agent-skill-discovery', async (importOriginal) => ({
  ...(await importOriginal()),
  notifyInstalledAgentSkillsChanged: vi.fn()
}))
vi.mock('@/hooks/useInstalledAgentSkills', async (importOriginal) => ({
  ...(await importOriginal()),
  notifyInstalledAgentSkillsRefreshed: vi.fn()
}))
vi.mock('@/hooks/useSkillFreshness', () => ({
  refreshSkillFreshness: vi.fn(),
  useSkillFreshness: () => ({ plan: null, loading: false, error: null })
}))
afterEach(cleanup)
beforeEach(() => mocks.plan.mockReset())

it('uses the named plan for its pill when a detected agent still needs the skill', async () => {
  mocks.plan.mockResolvedValue({
    kind: 'plan',
    plan: planOf([
      planEntry('orchestration', [
        planOp('keep', '/home/u/.claude/skills/orchestration', {
          observed: { kind: 'link', target: '/home/u/.agents/skills/orchestration' }
        }),
        planOp('link', '/home/u/.cursor/skills/orchestration', { agents: ['cursor'] })
      ])
    ])
  })
  render(
    <AgentSkillSetupPanel
      title="Orchestration"
      description={null}
      skillNames={['orchestration']}
      freshnessSkillName="orchestration"
      installed
      loading={false}
      error={null}
      onRecheck={vi.fn()}
    />
  )
  expect(await screen.findByRole('button', { name: 'Install for Cursor' })).toBeDefined()
  expect(screen.queryByText('Up to date')).toBeNull()
  expect(screen.getByRole('button', { name: 'Details' })).toBeDefined()
})

it.each([
  { kind: 'leave', label: 'Review skill', details: true },
  { kind: 'keep', label: 'Up to date', details: false }
] as const)(
  'uses $label even when the surface has no separate freshness inventory',
  async ({ kind, label, details }) => {
    mocks.plan.mockResolvedValue({
      kind: 'plan',
      plan: planOf([
        planEntry('orca-cli', [
          planOp(kind, '/home/u/.claude/skills/orca-cli', {
            observed: { kind: 'folder', entries: ['SKILL.md:file'], skillDigest: 'c'.repeat(64) },
            ...(kind === 'leave' ? { reason: 'edited', replaceable: true } : {})
          })
        ])
      ])
    })
    render(
      <AgentSkillSetupPanel
        title="Browser Use"
        description={null}
        skillNames={['orca-cli']}
        installed
        loading={false}
        error={null}
        onRecheck={vi.fn()}
      />
    )
    expect(await screen.findByText(label)).toBeDefined()
    expect(Boolean(screen.queryByRole('button', { name: 'Details' }))).toBe(details)
  }
)
