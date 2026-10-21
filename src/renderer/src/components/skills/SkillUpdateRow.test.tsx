// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BundledSkillOutcome } from '../../../../shared/bundled-skill-plan'
import { SkillUpdateRow } from './SkillUpdateRow'
import { planEntry, planOp } from './bundled-skill-plan-fixtures.test-support'

// Why: Radix unmounts closed content; render it so every location's label can be asserted.
vi.mock('@/components/ui/collapsible', () => ({
  Collapsible: ({ children, ...rest }: { children?: ReactNode } & Record<string, unknown>) => {
    const { defaultOpen: _defaultOpen, ...attributes } = rest
    return <div {...attributes}>{children}</div>
  },
  CollapsibleTrigger: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  CollapsibleContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>
}))

let root: Root | null = null
let container: HTMLDivElement | null = null

async function render(element: React.JSX.Element): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(element)
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

describe('SkillUpdateRow', () => {
  it('badges an update and labels each location', async () => {
    const view = await render(
      <SkillUpdateRow
        entry={planEntry('orca-cli', [planOp('update', SHARED), planOp('link', CLAUDE)])}
        phase="plan"
      />
    )
    expect(view.textContent).toContain('Update available')
    expect(view.textContent).toContain('Will update')
    expect(view.textContent).toContain('Will link')
    expect(view.textContent).toContain('2 locations')
  })

  it('badges link-only work as installing for that agent', async () => {
    const view = await render(
      <SkillUpdateRow
        entry={planEntry('orca-cli', [planOp('keep', SHARED), planOp('link', CLAUDE)])}
        phase="plan"
      />
    )
    expect(view.textContent).toContain('Install for Claude Code')
    expect(view.textContent).not.toContain('Update available')
  })

  it('names someone else’s same-named skill without flagging the row', async () => {
    const view = await render(
      <SkillUpdateRow
        entry={planEntry('orca-cli', [
          planOp('keep', SHARED),
          planOp('leave', CLAUDE, { reason: 'other', replaceable: true })
        ])}
        phase="plan"
      />
    )
    expect(view.textContent).toContain('Left alone: A different skill already uses this name')
    expect(view.querySelector('[data-skill-row]')?.getAttribute('data-state-label')).toBe('current')
  })

  it('offers Replace only for a replaceable copy and reports the choice', async () => {
    const onReplaceChange = vi.fn()
    const view = await render(
      <SkillUpdateRow
        entry={planEntry('orca-cli', [
          planOp('update', SHARED),
          planOp('leave', CLAUDE, { reason: 'edited', replaceable: true })
        ])}
        phase="plan"
        replace={{ isReplaced: () => false, onReplaceChange }}
      />
    )
    const checkboxes = view.querySelectorAll('[role="checkbox"]')
    expect(checkboxes).toHaveLength(1)
    await act(async () => {
      checkboxes[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onReplaceChange).toHaveBeenCalledWith(CLAUDE, true)
  })

  it('offers no Replace for a folder Orca cannot write', async () => {
    const view = await render(
      <SkillUpdateRow
        entry={planEntry('orca-cli', [
          planOp('leave', SHARED, { reason: 'unwritable', replaceable: false })
        ])}
        phase="plan"
        replace={{ isReplaced: () => false, onReplaceChange: vi.fn() }}
      />
    )
    expect(view.querySelector('[role="checkbox"]')).toBeNull()
    expect(view.textContent).toContain("Orca can't write to this folder")
  })

  it('reports each location’s outcome after the run', async () => {
    const outcome: BundledSkillOutcome = {
      name: 'orca-cli',
      status: 'ran',
      ops: [
        { path: SHARED, kind: 'update', status: 'done' },
        { path: CLAUDE, kind: 'link', status: 'failed', error: 'EACCES' }
      ]
    }
    const view = await render(
      <SkillUpdateRow
        entry={planEntry('orca-cli', [planOp('update', SHARED), planOp('link', CLAUDE)])}
        phase="result"
        outcome={outcome}
      />
    )
    expect(view.textContent).toContain('Needs attention')
    expect(view.textContent).toContain('Updated')
    expect(view.textContent).toContain('Failed: EACCES')
    expect(view.textContent).not.toContain('Update available')
  })
})
