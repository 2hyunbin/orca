// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BundledSkillInstallResult,
  BundledSkillLocalExecuteRequest,
  BundledSkillLocalPlanRequest,
  BundledSkillPlan
} from '../../../../shared/bundled-skill-plan'
import { SkillFreshnessUpdateDialog } from './SkillFreshnessUpdateDialog'
import {
  consumeSkillFreshnessUpdateDialogRequest,
  requestSkillFreshnessUpdateDialog
} from './skill-freshness-update-dialog'
import { _resetSkillUpdateRunStore, getSkillUpdateRun } from './skill-update-run-store'

const LOCAL_SKILL_UPDATE_TARGET = 'local'
import {
  doneResult,
  planEntry,
  planOf,
  planOp,
  sharedEntry
} from './bundled-skill-plan-fixtures.test-support'

const mocks = vi.hoisted(() => ({
  plan: ((): BundledSkillPlan | null => null)(),
  unsupported: ((): string | null => null)(),
  loading: false,
  error: null as string | null,
  refresh: vi.fn(),
  notifyChanged: vi.fn()
}))

vi.mock('@/hooks/useSkillFreshness', () => ({
  useSkillFreshness: () => ({
    plan: mocks.plan,
    unsupported: mocks.unsupported,
    loading: mocks.loading,
    error: mocks.error,
    refresh: mocks.refresh
  })
}))

vi.mock('@/hooks/useActiveProjectSkillRuntime', () => ({
  useActiveProjectSkillRuntime: () => ({ bundledSkillTarget: { kind: 'local' } })
}))

vi.mock('@/hooks/useInstalledAgentSkills', () => ({
  notifyInstalledAgentSkillsChanged: mocks.notifyChanged
}))

// Radix Dialog internals are exercised in Electron QA; here the content matters.
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
    open ? <div data-dialog-open="true">{children}</div> : null,
  DialogContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>
}))

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const skillsApi = {
  bundledPlan: vi.fn(async (_request?: BundledSkillLocalPlanRequest): Promise<BundledSkillPlan> =>
    planOf([])
  ),
  bundledExecute: vi.fn(
    async (_request: BundledSkillLocalExecuteRequest): Promise<BundledSkillInstallResult> => ({
      scope: 'global',
      skills: []
    })
  )
}

const EDITED_PATH = '/home/u/.claude/skills/orca-cli'

function editedPlan(): BundledSkillPlan {
  return planOf(
    [
      planEntry('orca-cli', [
        planOp('update', '/home/u/.agents/skills/orca-cli'),
        planOp('leave', EDITED_PATH, { reason: 'edited', replaceable: true })
      ])
    ],
    '1'.repeat(64)
  )
}

function forcedPlan(): BundledSkillPlan {
  return planOf(
    [
      planEntry('orca-cli', [
        planOp('update', '/home/u/.agents/skills/orca-cli'),
        planOp('replace', EDITED_PATH, { content: 'link' })
      ])
    ],
    '2'.repeat(64)
  )
}

let container: HTMLDivElement
let root: Root

function render(): void {
  act(() => {
    root.render(<SkillFreshnessUpdateDialog />)
  })
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label
  )
  if (!found) {
    throw new Error(`No button "${label}" in: ${container.textContent}`)
  }
  return found
}

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function replaceCheckbox(): HTMLElement {
  const label = [...container.querySelectorAll('label')].find((candidate) =>
    candidate.textContent?.includes('Replace')
  )
  const checkbox = label?.querySelector('[role="checkbox"]')
  if (!(checkbox instanceof HTMLElement)) {
    throw new Error('No Replace toggle')
  }
  return checkbox
}

beforeEach(() => {
  mocks.plan = null
  mocks.unsupported = null
  mocks.loading = false
  mocks.error = null
  mocks.refresh.mockReset()
  mocks.notifyChanged.mockReset()
  skillsApi.bundledPlan.mockReset()
  skillsApi.bundledExecute.mockReset()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { skills: skillsApi }
  })
  _resetSkillUpdateRunStore()
  consumeSkillFreshnessUpdateDialogRequest()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  requestSkillFreshnessUpdateDialog()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  consumeSkillFreshnessUpdateDialogRequest()
  _resetSkillUpdateRunStore()
})

describe('SkillFreshnessUpdateDialog', () => {
  it('lists only skills with something to do, and every location on request', () => {
    mocks.plan = planOf([
      planEntry('orca-cli', [
        planOp('update', '/home/u/.agents/skills/orca-cli'),
        planOp('keep', '/home/u/.claude/skills/orca-cli', {
          observed: { kind: 'link', target: '../../.agents/skills/orca-cli' }
        })
      ]),
      sharedEntry('orchestration', 'keep'),
      sharedEntry('orca-linear', 'keep')
    ])
    render()

    expect(container.textContent).toContain('1 update available')
    expect(container.querySelector('[data-skill-row="orca-cli"]')?.textContent).toBe(
      'orca-cliWill update'
    )
    expect(container.querySelector('[data-skill-row="orchestration"]')).toBeNull()
    expect(container.textContent).toContain('2 skills are up to date.')
    expect(button('Update 1 skill').disabled).toBe(false)

    click(button('Show all locations'))
    const row = container.querySelector('[data-skill-row="orca-cli"]')?.textContent ?? ''
    expect(row).toContain('Shared folder~/.agents/skills/orca-cliWill update')
    expect(row).toContain('Claude Code~/.claude/skills/orca-cliLink, no change')
    expect(container.querySelector('[data-skill-row="orchestration"]')).not.toBeNull()
  })

  it.each([
    ['update-server', 'Update Orca on the server to update its Orca skills.'],
    ['connect-host', 'Connect to this SSH host to check its Orca skills.']
  ])('explains a %s host instead of offering Update', (reason, text) => {
    mocks.unsupported = reason
    render()

    expect(container.textContent).toContain(text)
    expect(container.textContent).not.toMatch(/Update \d+ skills?/)
  })

  it('labels a link-only plan as installing for the agent, not an update', () => {
    mocks.plan = planOf([
      planEntry('orca-cli', [
        planOp('keep', '/home/u/.agents/skills/orca-cli'),
        planOp('link', '/home/u/.claude/skills/orca-cli')
      ])
    ])
    render()

    expect(container.textContent).toContain('All installed Orca skills are up to date.')
    expect(button('Install for Claude Code').disabled).toBe(false)
  })

  it('names a copy left alone by its agent, with its Replace choice', () => {
    mocks.plan = editedPlan()
    render()

    const row = container.querySelector('[data-skill-row="orca-cli"]')
    expect(row?.textContent).toContain("Claude Code: You've changed this copy")
    expect(row?.textContent).toContain("Replace with Orca's copy (keeps a backup)")
  })

  it('re-plans with force when Replace is toggled and executes that plan', async () => {
    mocks.plan = editedPlan()
    const forced = deferred<BundledSkillPlan>()
    skillsApi.bundledPlan.mockReturnValueOnce(forced.promise)
    render()

    click(replaceCheckbox())
    expect(skillsApi.bundledPlan).toHaveBeenCalledWith({ force: [EDITED_PATH] })
    // Why: the forced plan has not landed, so Update must not run the unforced one.
    expect(button('Update 1 skill').disabled).toBe(true)

    await act(async () => {
      forced.resolve(forcedPlan())
      await forced.promise
    })
    expect(container.textContent).toContain('Will replace')
    skillsApi.bundledExecute.mockResolvedValueOnce(doneResult(forcedPlan()))
    click(button('Update 1 skill'))
    await flush()

    expect(skillsApi.bundledExecute).toHaveBeenCalledWith({
      planDigest: '2'.repeat(64),
      request: { force: [EDITED_PATH] }
    })
  })

  it('reports each skill with its left-alone copies after the run', async () => {
    const plan = editedPlan()
    mocks.plan = plan
    skillsApi.bundledExecute.mockResolvedValueOnce(doneResult(plan))
    render()

    click(button('Update 1 skill'))
    await flush()

    expect(skillsApi.bundledExecute).toHaveBeenCalledWith({
      planDigest: plan.planDigest,
      request: { force: [] }
    })
    expect(container.textContent).toContain('Updated 1 skill · 1 left alone')
    const row = container.querySelector('[data-skill-row="orca-cli"]')?.textContent ?? ''
    expect(row).toContain('Updated')
    expect(row).toContain("Claude Code: You've changed this copy")
    expect(mocks.notifyChanged).toHaveBeenCalled()
    expect(button('Done')).toBeTruthy()
  })

  it('reports a location that changed since review as needing attention', async () => {
    const plan = planOf([sharedEntry('orca-cli', 'update')])
    mocks.plan = plan
    skillsApi.bundledExecute.mockResolvedValueOnce({
      scope: 'global',
      skills: [{ name: 'orca-cli', status: 'changed', ops: [] }]
    })
    render()

    click(button('Update 1 skill'))
    await flush()

    expect(container.textContent).toContain('Some skills need attention')
    expect(getSkillUpdateRun(LOCAL_SKILL_UPDATE_TARGET)).toMatchObject({
      state: 'done',
      summary: { ok: false, exitCode: 1 }
    })
  })

  it('drops a completion for a run that was reset while it was in flight', async () => {
    mocks.plan = planOf([sharedEntry('orca-cli', 'update')])
    const execution = deferred<BundledSkillInstallResult>()
    skillsApi.bundledExecute.mockReturnValueOnce(execution.promise)
    render()

    click(button('Update 1 skill'))
    expect(getSkillUpdateRun(LOCAL_SKILL_UPDATE_TARGET).state).toBe('running')
    _resetSkillUpdateRunStore()

    await act(async () => {
      execution.resolve(doneResult(planOf([sharedEntry('orca-cli', 'update')])))
      await execution.promise
    })
    expect(getSkillUpdateRun(LOCAL_SKILL_UPDATE_TARGET).state).toBe('idle')
    expect(mocks.notifyChanged).not.toHaveBeenCalled()
  })

  it('shows the error when the request itself fails', async () => {
    mocks.plan = planOf([sharedEntry('orca-cli', 'update')])
    skillsApi.bundledExecute.mockRejectedValueOnce(new Error('ipc closed'))
    render()

    click(button('Update 1 skill'))
    await flush()

    expect(container.textContent).toContain("The update didn't finish")
    expect(container.textContent).toContain('ipc closed')
  })

  it('acknowledges a finished run on close', async () => {
    const plan = planOf([sharedEntry('orca-cli', 'update')])
    mocks.plan = plan
    skillsApi.bundledExecute.mockResolvedValueOnce(doneResult(plan))
    render()
    click(button('Update 1 skill'))
    await flush()

    click(button('Done'))
    expect(getSkillUpdateRun(LOCAL_SKILL_UPDATE_TARGET).state).toBe('idle')
    expect(container.querySelector('[data-dialog-open]')).toBeNull()
  })

  it('offers no Update when nothing would change', () => {
    mocks.plan = planOf([sharedEntry('orca-cli', 'keep')])
    render()

    expect(container.textContent).toContain('All installed Orca skills are up to date.')
    expect(
      [...container.querySelectorAll('button')].some((candidate) =>
        candidate.textContent?.startsWith('Update ')
      )
    ).toBe(false)
  })
})
