// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { doneResult, planOf, sharedEntry } from '../skills/bundled-skill-plan-fixtures.test-support'
import { AgentSkillSetupPanel } from './AgentSkillSetupPanel'
import { LinearAgentSkillInstallCta } from './linear-agent-skill-install-cta'
import { BrowserAction } from '../feature-wall/FeatureWallBrowserAction'
import { AgentCapabilitiesSetupAction } from '../feature-wall/AgentCapabilitiesSetupAction'

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
  useInstalledAgentSkillNames: () => ({
    installed: false,
    loading: false,
    error: null,
    skills: [],
    refresh: mocks.refresh
  })
}))
vi.mock('@/runtime/runtime-bundled-skills-client', () => ({
  planBundledSkillsOnTarget: mocks.plan,
  executeBundledSkillsOnTarget: mocks.execute
}))
vi.mock('../feature-wall/FeatureWallSetupWorkflowActions', () => ({
  useSetupTargetWorktree: () => null
}))
vi.mock('../feature-wall/agent-capability-setup-status', async (importOriginal) => ({
  ...(await importOriginal()),
  useAgentCapabilitySetupStatus: () => ({
    readiness: {
      browserUseSkillInstalled: false,
      browserUseSkillLoading: false,
      computerUseSkillInstalled: false,
      computerUseSkillLoading: false,
      computerUseReady: false,
      computerUseChecking: false,
      computerUseUnavailable: true,
      orchestrationSkillInstalled: false,
      orchestrationSkillLoading: false
    },
    installStatus: Object.fromEntries(
      ['browserUse', 'computerUse', 'orchestration', 'linearTickets'].map((id) => [
        id,
        { label: 'Not installed', tone: 'pending', installed: false }
      ])
    )
  })
}))
vi.mock('../onboarding/onboarding-feature-setup', async (importOriginal) => ({
  ...(await importOriginal()),
  runOnboardingFeatureSetup: vi.fn(async () => ({
    selectedIds: ['browserUse'],
    skillNames: ['orca-cli'],
    warnings: [],
    computerUsePermissionsOpened: false
  }))
}))

beforeEach(() => {
  mocks.plan.mockReset()
  mocks.execute.mockReset()
  mocks.refresh.mockReset()
})
afterEach(cleanup)

function renderSurface(surface: 'panel' | 'linear' | 'browser' | 'capabilities'): void {
  render(
    surface === 'panel' ? (
      <AgentSkillSetupPanel
        title="CLI skill"
        description={null}
        skillNames={['orca-cli']}
        installed={false}
        loading={false}
        error={null}
        onRecheck={mocks.refresh}
      />
    ) : surface === 'linear' ? (
      <LinearAgentSkillInstallCta settings={null} />
    ) : surface === 'browser' ? (
      <BrowserAction done />
    ) : (
      <AgentCapabilitiesSetupAction
        onOrchestrationSkillInstalledChange={vi.fn()}
        onBrowserUseSkillInstalledChange={vi.fn()}
      />
    )
  )
}

for (const surface of ['panel', 'linear', 'browser', 'capabilities'] as const) {
  describe(`${surface} blocked setup`, () => {
    it.each(['edited', 'other'] as const)(
      'offers Replace without forcing a preview of a %s copy',
      async (reason) => {
        const name = surface === 'linear' ? 'orca-linear' : 'orca-cli'
        mocks.plan.mockResolvedValue({
          kind: 'plan',
          plan: planOf([sharedEntry(name, 'leave', { reason, replaceable: true })])
        })

        renderSurface(surface)

        expect(
          await screen.findByRole('button', { name: "Replace with Orca's copy" })
        ).toBeDefined()
        expect(mocks.plan.mock.calls.length).toBeGreaterThan(0)
        for (const [, request] of mocks.plan.mock.calls) {
          expect(request.force).toBeUndefined()
        }
        expect(mocks.execute).not.toHaveBeenCalled()
      }
    )

    it.each(['unwritable', 'busy'] as const)(
      'offers Retry when an absent skill is %s',
      async (reason) => {
        const name = surface === 'linear' ? 'orca-linear' : 'orca-cli'
        mocks.plan.mockResolvedValue({
          kind: 'plan',
          plan: planOf([sharedEntry(name, 'leave', { reason })])
        })
        renderSurface(surface)

        const retry = await screen.findByRole('button', { name: 'Retry' })
        expect(screen.getAllByText('Needs attention').length).toBeGreaterThan(0)
        expect(screen.queryByText('Installed', { exact: true })).toBeNull()
        expect(screen.queryByRole('button', { name: /^Install/ })).toBeNull()
        fireEvent.click(retry)
        await waitFor(() => expect(mocks.plan.mock.calls.length).toBeGreaterThan(1))
        expect(mocks.execute).not.toHaveBeenCalled()

        const writable = planOf([sharedEntry(name, 'write')])
        mocks.plan.mockResolvedValue({ kind: 'plan', plan: writable })
        mocks.execute.mockResolvedValue(doneResult(writable))
        fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
        await waitFor(() =>
          expect(mocks.execute).toHaveBeenCalledWith(TARGET, writable.planDigest, { names: [name] })
        )
      }
    )
  })
}
