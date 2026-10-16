// @vitest-environment happy-dom

import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkillInstallResult } from '../../../../shared/skill-install-contract'
import type { BundledOrcaSkillInstallOutcome } from '@/runtime/runtime-skills-client'
import { AgentSkillSetupPanel } from './AgentSkillSetupPanel'

type MockRuntimeTarget = { kind: 'local' } | { kind: 'environment'; environmentId: string } | null

const mocks = vi.hoisted(() => {
  const localRuntimeTarget = (): MockRuntimeTarget => ({ kind: 'local' })
  const runtimeTarget = localRuntimeTarget()
  return {
    install: vi.fn(),
    runtimeTarget,
    terminalProps: [] as {
      command: string
      onTerminalExit?: () => void
      onCommandFinished?: (bestEffortExitCode: number | null) => void
    }[],
    skillsChanged: vi.fn(),
    skillsRefreshed: vi.fn(),
    freshnessRefresh: vi.fn()
  }
})

vi.mock('@/runtime/runtime-skills-client', () => ({
  installBundledOrcaSkillsOnRuntimeTarget: mocks.install
}))

vi.mock('@/hooks/use-active-skill-discovery-runtime-target', () => ({
  useActiveSkillDiscoveryRuntimeTarget: () => mocks.runtimeTarget
}))

vi.mock('@/hooks/useInstalledAgentSkills', () => ({
  notifyInstalledAgentSkillsChanged: mocks.skillsChanged,
  notifyInstalledAgentSkillsRefreshed: mocks.skillsRefreshed
}))

vi.mock('@/hooks/useSkillFreshness', () => ({
  refreshSkillFreshness: mocks.freshnessRefresh
}))

vi.mock('../onboarding/OnboardingInlineCommandTerminal', () => ({
  OnboardingInlineCommandTerminal: (props: {
    command: string
    onTerminalExit?: () => void
    onCommandFinished?: (bestEffortExitCode: number | null) => void
  }) => {
    mocks.terminalProps.push(props)
    return <div data-testid="inline-command-terminal">{props.command}</div>
  }
}))

vi.mock('../skills/SkillFreshnessStatusPill', () => ({
  SkillFreshnessStatusPill: ({ skillName }: { skillName: string }) => (
    <span data-testid="skill-freshness">{skillName}</span>
  )
}))

function result(
  name: string,
  status: SkillInstallResult['status'],
  extra: Partial<SkillInstallResult> = {}
): SkillInstallResult {
  return {
    operationId: 'op',
    status,
    name,
    packageDigest: 'a'.repeat(64),
    placements: [],
    ...extra
  }
}

function installed(...results: SkillInstallResult[]): BundledOrcaSkillInstallOutcome {
  return { kind: 'installed', results }
}

function panelProps(
  overrides: Partial<ComponentProps<typeof AgentSkillSetupPanel>> = {}
): ComponentProps<typeof AgentSkillSetupPanel> {
  return {
    title: 'CLI skill',
    description: 'Enables agents to use Orca workflows.',
    skillNames: ['orca-cli'],
    terminalTitle: 'CLI skill setup',
    terminalAriaLabel: 'CLI skill install terminal',
    terminalWorktreeId: 'settings-cli-skill-terminal',
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
    mocks.install.mockReset()
    mocks.install.mockResolvedValue(installed(result('orca-cli', 'installed')))
    mocks.runtimeTarget = { kind: 'local' }
    mocks.terminalProps.length = 0
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

  it('installs the skills on the active runtime and rechecks when it finishes', async () => {
    const onRecheck = vi.fn(async () => {})
    await renderInteractivePanel({ onRecheck, freshnessSkillName: 'orca-cli' })

    await clickButton('Install')

    expect(mocks.install).toHaveBeenCalledWith({ kind: 'local' }, { names: ['orca-cli'] })
    expect(onRecheck).toHaveBeenCalledOnce()
    expect(mocks.skillsRefreshed).toHaveBeenCalledOnce()
    expect(mocks.freshnessRefresh).toHaveBeenCalledOnce()
    expect(mocks.terminalProps).toHaveLength(0)
  })

  it('shows progress while the install runs', async () => {
    let finish: ((value: BundledOrcaSkillInstallOutcome) => void) | null = null
    mocks.install.mockReturnValue(
      new Promise<BundledOrcaSkillInstallOutcome>((resolve) => {
        finish = resolve
      })
    )
    await renderInteractivePanel()

    await clickButton('Install')
    expect(findButton('Installing...').disabled).toBe(true)

    await act(async () => {
      finish?.(installed(result('orca-cli', 'installed')))
    })
    expect(findButton('Install').disabled).toBe(false)
  })

  it('installs into the selected WSL distro, or lets the host pick the default one', async () => {
    await renderInteractivePanel({
      agentRuntime: { runtime: 'wsl', wslDistro: 'Ubuntu', label: 'WSL Ubuntu' }
    })
    await clickButton('Install')
    expect(mocks.install).toHaveBeenLastCalledWith(
      { kind: 'local' },
      { names: ['orca-cli'], wsl: { distro: 'Ubuntu' } }
    )

    await act(async () => {
      root?.render(
        <AgentSkillSetupPanel
          {...panelProps({
            agentRuntime: { runtime: 'wsl', wslDistro: null, label: 'WSL default' }
          })}
        />
      )
    })
    await clickButton('Install')
    expect(mocks.install).toHaveBeenLastCalledWith(
      { kind: 'local' },
      { names: ['orca-cli'], wsl: {} }
    )
  })

  it('updates the installed name when it differs from the install name', async () => {
    await renderInteractivePanel({
      installed: true,
      skillNames: ['orca-linear'],
      installedSkillNames: ['linear-tickets']
    })

    await clickButton('Update')

    expect(mocks.install).toHaveBeenCalledWith({ kind: 'local' }, { names: ['linear-tickets'] })
  })

  it('reports a failed install with the reason and retries it', async () => {
    mocks.install.mockResolvedValueOnce(
      installed(result('orca-cli', 'conflict', { conflict: { kind: 'modified' } }))
    )
    await renderInteractivePanel()

    await clickButton('Install')

    expect(container?.textContent).toContain('Setup failed')
    expect(container?.textContent).toContain(
      'orca-cli: not changed, the installed copy has changes Orca did not make'
    )
    await clickButton('Retry')
    expect(mocks.install).toHaveBeenCalledTimes(2)
    expect(container?.textContent).not.toContain('Setup failed')
  })

  it('reports a known thrown install error in plain words', async () => {
    mocks.install.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'skills:installBundledOrca': Error: skill-install-wsl-unavailable"
      )
    )
    await renderInteractivePanel()

    await clickButton('Install')

    expect(container?.textContent).toContain(
      'WSL is not available on this machine, so Orca could not install the skills there.'
    )
    expect(container?.textContent).not.toContain('Error invoking remote method')
    expect(container?.textContent).not.toContain('skill-install-wsl-unavailable')
  })

  it('names an unknown install error code after the plain failure', async () => {
    mocks.install.mockRejectedValueOnce(new Error('skill-install-journal-invalid'))
    await renderInteractivePanel()

    await clickButton('Install')

    expect(container?.textContent).toContain(
      'Orca could not install the skills. (skill-install-journal-invalid)'
    )
  })

  it('shows Retry in place of Install after a failure', async () => {
    mocks.install.mockRejectedValueOnce(new Error('skill-install-home-unavailable'))
    await renderInteractivePanel()

    await clickButton('Install')

    const labels = Array.from(container?.querySelectorAll('button') ?? [], (button) =>
      button.textContent?.trim()
    )
    expect(labels).toContain('Retry')
    expect(labels).not.toContain('Install')
  })

  it('clears a failure when the machine that runs the agents changes', async () => {
    mocks.install.mockRejectedValueOnce(new Error('skill-install-home-unavailable'))
    await renderInteractivePanel()
    await clickButton('Install')
    expect(container?.textContent).toContain('Setup failed')

    mocks.runtimeTarget = { kind: 'environment', environmentId: 'env-2' }
    await act(async () => {
      root?.render(<AgentSkillSetupPanel {...panelProps()} />)
    })

    expect(container?.textContent).not.toContain('Setup failed')
    expect(findButton('Install').disabled).toBe(false)
  })

  it('keeps Install disabled until the runtime that runs the agents resolves', async () => {
    mocks.runtimeTarget = null
    await renderInteractivePanel()

    expect(findButton('Install').disabled).toBe(true)
  })

  it('does not install when the caller cancels before install', async () => {
    await renderInteractivePanel({
      onBeforeInstall: async () => {
        throw new Error('cancelled')
      }
    })

    await clickButton('Install')

    expect(mocks.install).not.toHaveBeenCalled()
  })

  it('falls back to the terminal install on a server without the bundled installer', async () => {
    mocks.install.mockResolvedValueOnce({ kind: 'unsupported' })
    const onRecheck = vi.fn(async () => {})
    await renderInteractivePanel({ onRecheck })

    await clickButton('Install')

    expect(mocks.terminalProps.at(-1)?.command).toMatch(
      /^npx skills@1\.7\.2 add https:\/\/github\.com\/stablyai\/orca\/tree\/\S+ --skill orca-cli --global$/
    )
    expect(onRecheck).not.toHaveBeenCalled()
    await act(async () => {
      mocks.terminalProps.at(-1)?.onCommandFinished?.(0)
    })
    await act(async () => {})
    expect(onRecheck).toHaveBeenCalledOnce()
  })
})
