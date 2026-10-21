import { describe, expect, it, vi } from 'vitest'
import { PaneResumeOutcomes } from './pane-resume-outcomes'
import { paneStartFactsOf, withPaneStartFacts } from './pane-start-statuses'
import { splitPublishedLayout } from '../../shared/workspace-layout/workspace-layout-records'
import type { PublishedWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-published'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `tab-1:${LEAF_ID}`

function outcomes() {
  const changed = vi.fn()
  return { changed, register: new PaneResumeOutcomes(changed) }
}

describe("a pane's resume outcome (layout-owner build)", () => {
  it('shows once the pane binds the terminal it names, not before', () => {
    const { changed, register } = outcomes()
    register.set(PANE_KEY, 'pty-new', 'restored')
    expect(changed).toHaveBeenCalledOnce()

    // The start's bind write has not landed: the pane still shows its old terminal.
    expect(register.get(PANE_KEY, { ptyId: 'pty-old', ptyGeneration: 1 })).toBeNull()
    expect(register.get(PANE_KEY, { ptyId: 'pty-new', ptyGeneration: 2 })).toBe('restored')
    expect(register.get(PANE_KEY, { ptyId: 'pty-new', ptyGeneration: 2 })).toBe('restored')
  })

  it('ends when the pane binds again, a same-id respawn included', () => {
    const { register } = outcomes()
    register.set(PANE_KEY, 'pty-1', 'resume-unavailable')
    expect(register.get(PANE_KEY, { ptyId: 'pty-1', ptyGeneration: 1 })).toBe('resume-unavailable')

    expect(register.get(PANE_KEY, { ptyId: 'pty-1', ptyGeneration: 2 })).toBeNull()
    expect(register.get(PANE_KEY, { ptyId: 'pty-1', ptyGeneration: 1 })).toBeNull()
  })

  it("rides the pane's binding record, never its tree", () => {
    const layout: PublishedWorkspaceLayout = {
      worktreeId: 'wt-1',
      groups: [{ id: 'g-1', tabIds: ['tab-1'] }],
      tabs: [
        {
          id: 'tab-1',
          kind: 'terminal',
          entityId: 'tab-1',
          executionHostId: LOCAL_EXECUTION_HOST_ID,
          createdAt: 1,
          customTitle: null,
          color: null,
          terminal: {
            root: { type: 'leaf', leafId: LEAF_ID },
            panes: [{ leafId: LEAF_ID, ptyId: 'pty-1', ptyGeneration: 1 }]
          }
        }
      ],
      editorFiles: [],
      browserTabs: []
    }
    const { register } = outcomes()
    register.set(PANE_KEY, 'pty-1', 'restored')

    const records = splitPublishedLayout(
      withPaneStartFacts(
        layout,
        paneStartFactsOf(layout, {
          paneResumeOutcome: (paneKey, pane) => register.get(paneKey, pane)
        })
      )
    )

    expect(records.paneTrees[0]!.panes).toEqual([{ leafId: LEAF_ID }])
    expect(records.bindings).toEqual([
      { leafId: LEAF_ID, ptyId: 'pty-1', ptyGeneration: 1, resumeOutcome: 'restored' }
    ])
  })
})
