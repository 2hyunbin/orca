// @vitest-environment happy-dom

import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BundledSkillPlan } from '../../../../shared/bundled-skill-plan'
import { planOf, sharedEntry } from '../skills/bundled-skill-plan-fixtures.test-support'
import { _skillFreshnessCacheForTests } from '@/hooks/useSkillFreshness'
import { AgentSkillSetupPanel } from './AgentSkillSetupPanel'

const mocks = vi.hoisted(() => ({
  skillsChanged: vi.fn(),
  skillsRefreshed: vi.fn()
}))

// Why: these tests count the freshness plans; the button's own plan is covered elsewhere.
vi.mock('@/hooks/use-bundled-skill-install-action', () => ({
  useBundledSkillInstallAction: () => ({ kind: 'run' })
}))

vi.mock('@/hooks/useInstalledAgentSkills', () => ({
  notifyInstalledAgentSkillsChanged: mocks.skillsChanged,
  notifyInstalledAgentSkillsRefreshed: mocks.skillsRefreshed
}))

vi.mock('@/hooks/useActiveProjectSkillRuntime', () => ({
  useActiveProjectSkillRuntime: () => ({ bundledSkillTarget: { kind: 'local' } })
}))

function plan(updateNames: string[]): BundledSkillPlan {
  return planOf(updateNames.map((name) => sharedEntry(name, 'update')))
}

function panelProps(
  onRecheck: () => void | Promise<unknown> = vi.fn()
): ComponentProps<typeof AgentSkillSetupPanel> {
  return {
    title: 'Linear skill',
    description: null,
    skillNames: ['orca-linear'],
    installed: true,
    loading: false,
    error: null,
    hideHeader: true,
    showRecheckWhenInstalled: true,
    freshnessSkillName: 'orca-linear',
    onRecheck
  }
}

let root: Root | null = null
let container: HTMLDivElement | null = null

describe('AgentSkillSetupPanel freshness re-check', () => {
  beforeEach(() => {
    _skillFreshnessCacheForTests.reset()
    mocks.skillsChanged.mockReset()
    mocks.skillsRefreshed.mockReset()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount())
    }
    root = null
    container?.remove()
    container = null
    Reflect.deleteProperty(window, 'api')
  })

  it('re-plans skill freshness and updates the rendered verdict on re-check', async () => {
    let completeRecheck: (() => void) | null = null
    // Why: a rescan started before the install scan finishes would re-read the same
    // pre-update disk state, so the boundary is what the assertions below pin.
    const onRecheck = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          completeRecheck = resolve
        })
    )
    let completeRescan: ((value: BundledSkillPlan) => void) | null = null
    const bundledPlan = vi
      .fn()
      .mockResolvedValueOnce(plan(['orca-linear']))
      .mockImplementationOnce(
        () =>
          new Promise<BundledSkillPlan>((resolve) => {
            completeRescan = resolve
          })
      )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double implements only the preload methods this code path calls.
    window.api = { skills: { bundledPlan } } as never

    await act(async () => root?.render(<AgentSkillSetupPanel {...panelProps(onRecheck)} />))
    await act(async () => {})

    expect(bundledPlan).toHaveBeenCalledTimes(1)
    expect(container?.textContent).toContain('Update available')

    const recheck = Array.from(container?.querySelectorAll('button') ?? []).find(
      (candidate) => candidate.textContent?.trim() === 'Re-check'
    )
    expect(recheck).toBeDefined()

    await act(async () => {
      recheck?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {})

    expect(onRecheck).toHaveBeenCalledOnce()
    expect(mocks.skillsRefreshed).not.toHaveBeenCalled()
    expect(bundledPlan).toHaveBeenCalledTimes(1)

    await act(async () => {
      completeRecheck?.()
    })
    await act(async () => {})

    expect(mocks.skillsRefreshed).toHaveBeenCalledOnce()
    expect(bundledPlan).toHaveBeenCalledTimes(2)
    expect(container?.textContent).toContain('Checking...')
    expect(container?.textContent).not.toContain('Update available')

    await act(async () => {
      completeRescan?.(plan([]))
    })
    await act(async () => {})

    expect(container?.textContent).not.toContain('Checking...')
    expect(container?.textContent).not.toContain('Update available')
  })

  it('shows a failed verdict when the post-recheck plan fails', async () => {
    const bundledPlan = vi
      .fn()
      .mockResolvedValueOnce(plan(['orca-linear']))
      .mockRejectedValueOnce(new Error('plan unavailable'))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double implements only the preload methods this code path calls.
    window.api = { skills: { bundledPlan } } as never

    await act(async () => root?.render(<AgentSkillSetupPanel {...panelProps()} />))
    await act(async () => {})

    const recheck = Array.from(container?.querySelectorAll('button') ?? []).find(
      (candidate) => candidate.textContent?.trim() === 'Re-check'
    )
    await act(async () => {
      recheck?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {})

    expect(container?.textContent).toContain('Check failed')
    expect(container?.textContent).not.toContain('Installed')
    expect(container?.textContent).not.toContain('Up to date')
  })
})
