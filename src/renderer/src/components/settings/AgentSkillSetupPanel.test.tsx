// @vitest-environment happy-dom

import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BundledSkillInstallResult } from '../../../../shared/bundled-skill-plan'
import type { BundledSkillTarget } from '@/lib/bundled-skill-target'
import { doneResult, planOf, sharedEntry } from '../skills/bundled-skill-plan-fixtures.test-support'
import { AgentSkillSetupPanel } from './AgentSkillSetupPanel'

const mocks = vi.hoisted(() => {
  const localTarget = (): BundledSkillTarget | null => ({ kind: 'local' })
  return {
    plan: vi.fn(),
    execute: vi.fn(),
    target: localTarget(),
    skillsChanged: vi.fn(),
    skillsRefreshed: vi.fn(),
    freshnessRefresh: vi.fn()
  }
})

vi.mock('@/runtime/runtime-bundled-skills-client', () => ({
  planBundledSkillsOnTarget: mocks.plan,
  executeBundledSkillsOnTarget: mocks.execute
}))

vi.mock('@/hooks/useActiveProjectSkillRuntime', () => ({
  useActiveProjectSkillRuntime: () => ({ bundledSkillTarget: mocks.target })
}))

vi.mock('@/hooks/installed-agent-skill-discovery', () => ({
  notifyInstalledAgentSkillsChanged: mocks.skillsChanged
}))

vi.mock('@/hooks/useInstalledAgentSkills', () => ({
  notifyInstalledAgentSkillsRefreshed: mocks.skillsRefreshed
}))

vi.mock('@/hooks/useSkillFreshness', () => ({
  refreshSkillFreshness: mocks.freshnessRefresh
}))

vi.mock('../skills/SkillFreshnessStatusPill', () => ({
  SkillFreshnessStatusPill: ({ skillName }: { skillName: string }) => (
    <span data-testid="skill-freshness">{skillName}</span>
  )
}))

const WRITE_PLAN = planOf([sharedEntry('orca-cli', 'write')])

function panelProps(
  overrides: Partial<ComponentProps<typeof AgentSkillSetupPanel>> = {}
): ComponentProps<typeof AgentSkillSetupPanel> {
  return {
    title: 'CLI skill',
    description: 'Enables agents to use Orca workflows.',
    skillNames: ['orca-cli'],
    installed: false,
    loading: false,
    error: null,
    onRecheck: vi.fn(),
    ...overrides
  }
}

function renderPanel(overrides: Partial<ComponentProps<typeof AgentSkillSetupPanel>> = {}): string {
  return renderToStaticMarkup(<AgentSkillSetupPanel {...panelProps(overrides)} />)
}

function buttonLabels(html: string): string[] {
  return Array.from(html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g), ([, content]) =>
    content
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

function buttonMarkupByLabel(html: string, label: string): string | undefined {
  return Array.from(html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g), ([button]) => button).find(
    (button) => buttonLabels(button).includes(label)
  )
}

let root: Root | null = null
let container: HTMLDivElement | null = null

async function renderInteractivePanel(
  overrides: Partial<ComponentProps<typeof AgentSkillSetupPanel>> = {}
): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<AgentSkillSetupPanel {...panelProps(overrides)} />)
  })
  await act(async () => {})
  return container
}

function findButton(label: string): HTMLButtonElement {
  const button = Array.from((container ?? document.body).querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label
  )
  expect(button).toBeDefined()
  return button as HTMLButtonElement
}

async function clickButton(label: string): Promise<void> {
  await act(async () => {
    findButton(label).dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await act(async () => {})
}

describe('AgentSkillSetupPanel', () => {
  beforeEach(() => {
    mocks.plan.mockReset()
    mocks.plan.mockResolvedValue({ kind: 'plan', plan: WRITE_PLAN })
    mocks.execute.mockReset()
    mocks.execute.mockResolvedValue(doneResult(WRITE_PLAN))
    mocks.target = { kind: 'local' }
    mocks.skillsChanged.mockReset()
    mocks.skillsRefreshed.mockReset()
    mocks.freshnessRefresh.mockReset()
    mocks.freshnessRefresh.mockResolvedValue(undefined)
  })

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount()
      })
    }
    root = null
    container?.remove()
    container = null
  })

  it('keeps the install action visible after the skill is detected', () => {
    const html = renderPanel({ installed: true })

    expect(html).toContain('Installed')
    expect(buttonLabels(html)).toContain('Update')
    expect(buttonLabels(html)).toContain('Re-check')
  })

  it('surfaces skill freshness under hideHeader for guided setup hubs', () => {
    const html = renderPanel({
      installed: true,
      hideHeader: true,
      description: null,
      freshnessSkillName: 'orca-linear'
    })

    expect(html).toContain('data-testid="skill-freshness"')
    expect(html).toContain('orca-linear')
    expect(html).not.toContain('CLI skill')
  })

  it('does not render an empty description paragraph when description is null', () => {
    const html = renderPanel({ description: null, hideHeader: true })

    expect(html).not.toContain('text-muted-foreground">null')
    expect(html).not.toMatch(/<p class="text-\[13px\] leading-snug text-muted-foreground"><\/p>/)
  })

  it('hides only re-check when installed re-checks are disabled', () => {
    const html = renderPanel({ installed: true, showRecheckWhenInstalled: false })

    expect(html).toContain('Installed')
    expect(buttonLabels(html)).toContain('Update')
    expect(buttonLabels(html)).not.toContain('Re-check')
  })

  it('can hide install after the skill is detected', () => {
    const html = renderPanel({ installed: true, showInstallWhenInstalled: false })

    expect(html).toContain('Installed')
    expect(buttonLabels(html)).not.toContain('Install')
    expect(buttonLabels(html)).toContain('Re-check')
  })

  it('keeps re-check visible before install when installed re-checks are disabled', () => {
    const html = renderPanel({ installed: false, showRecheckWhenInstalled: false })

    expect(buttonLabels(html)).toContain('Install')
    expect(buttonLabels(html)).toContain('Re-check')
  })

  it('keeps install visible but disabled when parent setup is disabled', () => {
    const html = renderPanel({ installDisabled: true })

    expect(buttonMarkupByLabel(html, 'Install')).toContain('disabled=""')
  })

  it('notifies sibling surfaces only after re-check finishes', async () => {
    let finishRecheck: (() => void) | null = null
    const recheck = new Promise<void>((resolve) => {
      finishRecheck = resolve
    })
    await renderInteractivePanel({ onRecheck: () => recheck })

    await clickButton('Re-check')
    expect(mocks.skillsRefreshed).not.toHaveBeenCalled()

    await act(async () => {
      finishRecheck?.()
      await recheck
    })

    expect(mocks.skillsRefreshed).toHaveBeenCalledOnce()
    expect(mocks.skillsChanged).not.toHaveBeenCalled()
  })

  it('plans the named skills on the active host, runs that plan, and rechecks', async () => {
    const onRecheck = vi.fn(async () => {})
    await renderInteractivePanel({ onRecheck, freshnessSkillName: 'orca-cli' })

    await clickButton('Install')

    expect(mocks.plan).toHaveBeenCalledWith({ kind: 'local' }, { names: ['orca-cli'] })
    expect(mocks.execute).toHaveBeenCalledWith({ kind: 'local' }, WRITE_PLAN.planDigest, {
      names: ['orca-cli']
    })
    expect(container?.textContent).toContain('Installed')
    expect(mocks.skillsChanged).toHaveBeenCalledOnce()
    expect(onRecheck).toHaveBeenCalledOnce()
    expect(mocks.freshnessRefresh).toHaveBeenCalledOnce()
  })

  it('never installs on this machine for a paired host', async () => {
    mocks.target = { kind: 'environment', environmentId: 'env-1' }
    await renderInteractivePanel()

    await clickButton('Install')

    expect(mocks.plan).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      { names: ['orca-cli'] }
    )
  })

  it('shows progress while the install runs', async () => {
    let finish: ((value: BundledSkillInstallResult) => void) | null = null
    mocks.execute.mockReturnValue(
      new Promise<BundledSkillInstallResult>((resolve) => {
        finish = resolve
      })
    )
    await renderInteractivePanel()

    await clickButton('Install')
    expect(findButton('Installing...').disabled).toBe(true)

    await act(async () => {
      finish?.(doneResult(WRITE_PLAN))
    })
    expect(findButton('Install').disabled).toBe(false)
  })

  it('updates the installed name when it differs from the install name', async () => {
    await renderInteractivePanel({
      installed: true,
      skillNames: ['orca-linear'],
      installedSkillNames: ['linear-tickets']
    })

    await clickButton('Update')

    expect(mocks.plan).toHaveBeenCalledWith({ kind: 'local' }, { names: ['linear-tickets'] })
  })

  it('says why an edited copy was left alone, without calling it a failure', async () => {
    const plan = planOf([sharedEntry('orca-cli', 'leave', { reason: 'edited', replaceable: true })])
    mocks.plan.mockResolvedValueOnce({ kind: 'plan', plan })
    mocks.execute.mockResolvedValueOnce(doneResult(plan))
    await renderInteractivePanel({ installed: true })

    await clickButton('Update')

    expect(container?.textContent).toContain("No change · 1 left alone: You've changed this copy")
    expect(container?.textContent).not.toContain('Needs attention')
  })

  it('reports a run that found the disk changed as needing attention, and retries it', async () => {
    mocks.execute.mockResolvedValueOnce({
      scope: 'global',
      skills: [{ name: 'orca-cli', status: 'changed', ops: [] }]
    })
    await renderInteractivePanel()

    await clickButton('Install')

    expect(container?.textContent).toContain('Needs attention')
    await clickButton('Retry')
    expect(mocks.plan).toHaveBeenCalledTimes(2)
    expect(container?.textContent).not.toContain('Needs attention')
  })

  it('reports a known thrown install error in plain words', async () => {
    mocks.plan.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'skills:bundledPlan': Error: skill-install-wsl-unavailable"
      )
    )
    await renderInteractivePanel()

    await clickButton('Install')

    expect(container?.textContent).toContain(
      'WSL is not available on this machine, so Orca could not install the skills there.'
    )
    expect(container?.textContent).not.toContain('Error invoking remote method')
  })

  it('names an unknown install error code after the plain failure', async () => {
    mocks.execute.mockRejectedValueOnce(new Error('skill-install-journal-invalid'))
    await renderInteractivePanel()

    await clickButton('Install')

    expect(container?.textContent).toContain(
      'Orca could not install the skills. (skill-install-journal-invalid)'
    )
  })

  it('shows Retry in place of Install after a failure', async () => {
    mocks.plan.mockRejectedValueOnce(new Error('skill-install-home-unavailable'))
    await renderInteractivePanel()

    await clickButton('Install')

    const labels = Array.from(container?.querySelectorAll('button') ?? [], (button) =>
      button.textContent?.trim()
    )
    expect(labels).toContain('Retry')
    expect(labels).not.toContain('Install')
  })

  it('keeps each host its own result', async () => {
    mocks.plan.mockRejectedValueOnce(new Error('skill-install-home-unavailable'))
    await renderInteractivePanel()
    await clickButton('Install')
    expect(container?.textContent).toContain('Needs attention')

    mocks.target = { kind: 'environment', environmentId: 'env-2' }
    await act(async () => {
      root?.render(<AgentSkillSetupPanel {...panelProps()} />)
    })
    expect(container?.textContent).not.toContain('Needs attention')
    expect(findButton('Install').disabled).toBe(false)

    mocks.target = { kind: 'local' }
    await act(async () => {
      root?.render(<AgentSkillSetupPanel {...panelProps()} />)
    })
    expect(container?.textContent).toContain('Needs attention')
  })

  it('keeps Install disabled while the host that runs the agents is unknown', async () => {
    mocks.target = null
    await renderInteractivePanel()

    expect(findButton('Install').disabled).toBe(true)
    expect(container?.textContent).toContain(
      "Orca can't install skills on this workspace's machine yet."
    )
  })

  it('does not install when the caller cancels before install', async () => {
    await renderInteractivePanel({
      onBeforeInstall: async () => {
        throw new Error('cancelled')
      }
    })

    await clickButton('Install')

    expect(mocks.plan).not.toHaveBeenCalled()
  })

  it('asks for a newer Orca on a server without the installer, writing nothing here', async () => {
    mocks.plan.mockResolvedValueOnce({ kind: 'unsupported' })
    mocks.target = { kind: 'environment', environmentId: 'old' }
    const onRecheck = vi.fn(async () => {})
    await renderInteractivePanel({ onRecheck })

    await clickButton('Install')

    expect(container?.textContent).toContain('Update Orca on the server to install its skills.')
    expect(mocks.execute).not.toHaveBeenCalled()
    expect(onRecheck).not.toHaveBeenCalled()
  })
})
