// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BundledSkillOp, BundledSkillOutcome } from '../../../../shared/bundled-skill-plan'
import {
  summarizeBundledSkillOutcome,
  summarizeBundledSkillPlan
} from '../../../../shared/bundled-skill-summary'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SkillUpdateRow } from './SkillUpdateRow'
import { planEntry, planOf, planOp } from './bundled-skill-plan-fixtures.test-support'

let root: Root | null = null
let container: HTMLDivElement | null = null

async function render(element: React.JSX.Element): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<TooltipProvider>{element}</TooltipProvider>)
  })
  return container
}

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount())
  }
  root = null
  container?.remove()
  container = null
})

const SHARED = '/home/u/.agents/skills/orca-cli'
const CLAUDE = '/home/u/.claude/skills/orca-cli'

function skillOf(ops: BundledSkillOp[]) {
  return summarizeBundledSkillPlan(planOf([planEntry('orca-cli', ops)])).skills[0]
}

function row(view: HTMLElement): string {
  return view.querySelector('[data-skill-row="orca-cli"]')?.textContent ?? ''
}

describe('SkillUpdateRow', () => {
  it('says what Update does, and lists locations only on request', async () => {
    const skill = skillOf([planOp('update', SHARED), planOp('keep', CLAUDE)])
    expect(
      row(await render(<SkillUpdateRow skill={skill} phase="plan" showLocations={false} />))
    ).toBe('orca-cliWill update')
    await act(async () => root?.unmount())
    const shown = row(await render(<SkillUpdateRow skill={skill} phase="plan" showLocations />))
    expect(shown).toContain('Shared folder~/.agents/skills/orca-cliWill update')
    expect(shown).toContain('Claude Code~/.claude/skills/orca-cliNo change')
  })

  it('names a copy left alone by agent and offers Replace only where it is allowed', async () => {
    const onReplaceChange = vi.fn()
    const view = await render(
      <SkillUpdateRow
        skill={skillOf([
          planOp('leave', SHARED, { reason: 'unwritable', replaceable: false }),
          planOp('leave', CLAUDE, { reason: 'edited', replaceable: true })
        ])}
        phase="plan"
        showLocations={false}
        replace={{ isReplaced: () => false, onReplaceChange }}
      />
    )
    expect(row(view)).toContain("Shared folder: Orca can't write to this folder")
    expect(row(view)).toContain("Claude Code: You've changed this copy")
    const checkboxes = view.querySelectorAll('[role="checkbox"]')
    expect(checkboxes).toHaveLength(1)
    await act(async () => {
      checkboxes[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onReplaceChange).toHaveBeenCalledWith(CLAUDE, true)
  })

  it('shows the outcome after a run, keeping what was left alone', async () => {
    const outcome: BundledSkillOutcome = {
      name: 'orca-cli',
      status: 'ran',
      ops: [
        { path: SHARED, kind: 'update', status: 'done' },
        { path: CLAUDE, kind: 'leave', status: 'done', reason: 'edited' }
      ]
    }
    const view = await render(
      <SkillUpdateRow
        skill={skillOf([
          planOp('keep', SHARED),
          planOp('leave', CLAUDE, { reason: 'edited', replaceable: true })
        ])}
        phase="result"
        outcome={summarizeBundledSkillOutcome(outcome)}
        showLocations={false}
      />
    )
    expect(row(view)).toBe("orca-cliUpdatedClaude Code: You've changed this copy")
  })
})
