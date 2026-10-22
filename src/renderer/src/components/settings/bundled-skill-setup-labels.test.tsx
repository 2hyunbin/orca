// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BundledSkillOp } from '../../../../shared/bundled-skill-plan'
import {
  doneResult,
  planEntry,
  planOf,
  planOp
} from '../skills/bundled-skill-plan-fixtures.test-support'
import { AgentSkillSetupPanel } from './AgentSkillSetupPanel'
import { LinearAgentSkillInstallCta } from './linear-agent-skill-install-cta'

const mocks = vi.hoisted(() => ({ plan: vi.fn(), execute: vi.fn(), refresh: vi.fn() }))
const TARGET = { kind: 'environment', environmentId: 'agents-host' } as const

vi.mock('@/hooks/useActiveProjectSkillRuntime', () => ({
  useActiveProjectSkillRuntime: () => ({ bundledSkillTarget: TARGET })
}))
vi.mock('@/hooks/installed-agent-skill-discovery', async (importOriginal) => ({
  ...(await importOriginal()),
  notifyInstalledAgentSkillsChanged: vi.fn()
}))
vi.mock('@/hooks/useInstalledAgentSkills', async (importOriginal) => ({
  ...(await importOriginal()),
  GLOBAL_AGENT_SKILL_SOURCE_KINDS: ['home'],
  notifyInstalledAgentSkillsRefreshed: vi.fn(),
  useInstalledAgentSkillNames: () => ({
    installed: true,
    loading: false,
    error: null,
    skills: [],
    refresh: mocks.refresh
  })
}))
vi.mock('@/hooks/useSkillFreshness', () => ({ refreshSkillFreshness: vi.fn() }))
vi.mock('@/runtime/runtime-bundled-skills-client', () => ({
  planBundledSkillsOnTarget: mocks.plan,
  executeBundledSkillsOnTarget: mocks.execute
}))

function operations(
  name: string,
  update: boolean,
  agents: string[],
  edited = false
): BundledSkillOp[] {
  return [
    planOp(update ? 'update' : 'keep', `/home/u/.agents/skills/${name}`),
    planOp('keep', `/home/u/.claude/skills/${name}`),
    ...agents.map((agent) =>
      planOp('link', `/home/u/.${agent}/skills/${name}`, {
        agents: agent === 'cursor' ? ['cursor'] : ['gemini']
      })
    ),
    ...(edited
      ? [
          planOp('leave', `/home/u/.factory/skills/${name}`, {
            reason: 'edited',
            replaceable: true
          })
        ]
      : [])
  ]
}

beforeEach(() => {
  mocks.plan.mockReset()
  mocks.execute.mockReset()
  mocks.refresh.mockReset()
})
afterEach(cleanup)

for (const surface of ['panel', 'linear'] as const) {
  describe(`${surface} setup plan labels`, () => {
    it.each([
      {
        update: false,
        agents: ['cursor'],
        button: 'Install for Cursor',
        result: 'Installed for Cursor'
      },
      {
        update: false,
        agents: ['cursor', 'gemini'],
        button: 'Install for 2 more agents',
        result: 'Installed for 2 more agents'
      },
      { update: true, agents: [], button: 'Update', result: 'Updated' },
      {
        update: true,
        agents: ['cursor'],
        button: 'Update',
        result: 'Updated · Installed for Cursor'
      },
      {
        update: true,
        agents: ['cursor', 'gemini'],
        button: 'Update',
        result: 'Updated · Installed for 2 more agents'
      }
    ])('labels $button and reports $result', async ({ update, agents, button, result }) => {
      const name = surface === 'panel' ? 'orca-cli' : 'orca-linear'
      const plan = planOf([planEntry(name, operations(name, update, agents))])
      mocks.plan.mockResolvedValue({ kind: 'plan', plan })
      mocks.execute.mockResolvedValue(doneResult(plan))
      render(
        surface === 'panel' ? (
          <AgentSkillSetupPanel
            title="CLI skill"
            description={null}
            skillNames={[name]}
            installed
            loading={false}
            error={null}
            onRecheck={mocks.refresh}
          />
        ) : (
          <LinearAgentSkillInstallCta settings={null} />
        )
      )
      fireEvent.click(await screen.findByRole('button', { name: button }))
      expect(await screen.findByText(result, { exact: true })).toBeDefined()
      expect(mocks.plan).toHaveBeenCalledWith(TARGET, { names: [name] })
      expect(mocks.execute).toHaveBeenCalledWith(TARGET, plan.planDigest, { names: [name] })
    })

    it('shows Installed without an install button when every copy is current', async () => {
      const name = surface === 'panel' ? 'orca-cli' : 'orca-linear'
      mocks.plan.mockResolvedValue({
        kind: 'plan',
        plan: planOf([planEntry(name, operations(name, false, []))])
      })
      render(
        surface === 'panel' ? (
          <AgentSkillSetupPanel
            title="CLI skill"
            description={null}
            skillNames={[name]}
            installed
            loading={false}
            error={null}
            onRecheck={mocks.refresh}
          />
        ) : (
          <LinearAgentSkillInstallCta settings={null} />
        )
      )
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: /^(Install|Update)/ })).toBeNull()
      )
      expect(screen.getByText('Installed', { exact: true })).toBeDefined()
      expect(mocks.execute).not.toHaveBeenCalled()
    })
  })
}

it('keeps the edited-copy suffix after the mixed result', async () => {
  const plan = planOf([planEntry('orca-cli', operations('orca-cli', true, ['cursor'], true))])
  mocks.plan.mockResolvedValue({ kind: 'plan', plan })
  mocks.execute.mockResolvedValue(doneResult(plan))
  render(
    <AgentSkillSetupPanel
      title="CLI skill"
      description={null}
      skillNames={['orca-cli']}
      installed
      loading={false}
      error={null}
      onRecheck={mocks.refresh}
    />
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Update' }))
  expect(
    await screen.findByText(
      "Updated · Installed for Cursor · 1 left alone: You've changed this copy"
    )
  ).toBeDefined()
})
