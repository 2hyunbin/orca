// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BundledSkillOp, BundledSkillOutcome } from '../../../../shared/bundled-skill-plan'
import {
  BUNDLED_SKILL_PLAN_OP_TEXT,
  summarizeBundledSkillPlan
} from '../../../../shared/bundled-skill-summary'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SkillUpdateRow } from './SkillUpdateRow'
import { locationStateText } from './skill-plan-op-copy'
import { bundledSkillLocation } from '../../../../shared/bundled-skill-locations'
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
  it.each([
    ['update', 'Update'],
    ['restore', 'Repair'],
    ['write', 'Install'],
    ['copy', 'Install'],
    ['link', 'Link'],
    ['replace', 'Replace']
  ] as const)('uses the short %s action in the renderer and CLI', (kind, label) => {
    const location = bundledSkillLocation(planOp(kind, CLAUDE), '/home/u')
    expect(locationStateText(location)).toBe(label)
    expect(BUNDLED_SKILL_PLAN_OP_TEXT[kind]).toBe(label)
  })

  it('reports an unknown reason without claiming the copy was updated', async () => {
    const view = await render(
      <SkillUpdateRow
        skill={skillOf([planOp('leave', CLAUDE)])}
        phase="plan"
        showLocations={false}
      />
    )
    expect(row(view)).toBe('orca-cliNot updated: this copy was kept as it is')
  })

  it.each([
    ['edited', 'you edited this copy'],
    ['other', 'a different skill already uses this name'],
    ['unwritable', "Orca can't write to this folder"],
    ['unreadable', "Orca can't read every file in this copy"],
    ['busy', 'another skill install is still finishing here'],
    ['shared-not-current', 'the shared copy this folder uses is not Orca’s']
  ] as const)(
    'explains %s copies without repeating the status on folder lines',
    async (reason, text) => {
      const view = await render(
        <SkillUpdateRow
          skill={skillOf([planOp('leave', CLAUDE, { reason })])}
          phase="plan"
          showLocations
        />
      )
      expect(row(view)).toBe(`orca-cliNot updated: ${text}Claude Code · ~/.claude/skills/orca-cli`)
    }
  )

  it('says what Update does, and lists locations only on request', async () => {
    const skill = skillOf([planOp('update', SHARED), planOp('keep', CLAUDE)])
    expect(
      row(await render(<SkillUpdateRow skill={skill} phase="plan" showLocations={false} />))
    ).toBe('orca-cliUpdate')
    await act(async () => root?.unmount())
    const shown = row(await render(<SkillUpdateRow skill={skill} phase="plan" showLocations />))
    expect(shown).toContain('Shared folder · ~/.agents/skills/orca-cli')
    expect(shown).toContain('Claude Code · ~/.claude/skills/orca-cli')
    expect(shown.match(/Update/gu)).toHaveLength(1)
    expect(shown).not.toContain('No change')
  })

  it('reports a copy not updated without an agent prefix and offers Replace only where it is allowed', async () => {
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
    expect(row(view)).toContain("Not updated: Orca can't write to this folder")
    expect(row(view)).toContain('Not updated: you edited this copy')
    expect(row(view)).not.toContain('Claude Code:')
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
        outcome={outcome}
        showLocations={false}
      />
    )
    expect(row(view)).toBe('orca-cliUpdatedNot updated: you edited this copy')
  })

  it.each<{
    ops: BundledSkillOutcome['ops']
    text: string
  }>([
    {
      ops: [{ path: CLAUDE, kind: 'replace', status: 'done' }],
      text: 'Replaced · Your copy was saved as a backup'
    },
    {
      ops: [{ path: CLAUDE, kind: 'update', status: 'done' }],
      text: 'Updated'
    },
    {
      ops: [{ path: CLAUDE, kind: 'replace', status: 'skipped' }],
      text: 'Needs attention'
    },
    {
      ops: [
        { path: CLAUDE, kind: 'replace', status: 'done' },
        { path: SHARED, kind: 'update', status: 'failed' }
      ],
      text: 'Needs attention'
    }
  ])('shows $text from the executed operations after the plan refreshes', async ({ ops, text }) => {
    const view = await render(
      <SkillUpdateRow
        skill={skillOf([planOp('keep', SHARED), planOp('keep', CLAUDE)])}
        phase="result"
        outcome={{ name: 'orca-cli', status: 'ran', ops }}
        showLocations={false}
      />
    )
    expect(row(view)).toBe(`orca-cli${text}`)
  })
})
