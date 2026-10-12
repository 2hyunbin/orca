import { describe, expect, it } from 'vitest'
import { build, terminalTab, testContext, WS } from './workspace-layout-command.test-fixture'
import type { LayoutSleepingRecord, WorkspaceLayoutModel } from './workspace-layout-model'
import { recoverLegacyWorker } from './workspace-layout-legacy-worker-recovery'
import { applyLayoutTransition } from './workspace-layout-transitions'

const SLEEPING: LayoutSleepingRecord = {
  agent: 'codex',
  providerSession: { key: 'session_id', id: 'legacy-session' },
  prompt: 'continue',
  state: 'working',
  capturedAt: 1,
  updatedAt: 1
}

/** A terminal tab split in two; the first pane runs the legacy worker and carries its record. */
function setup() {
  const context = testContext()
  const created = build(context, [{ type: 'createTerminalTab', workspace: WS }])
  const { tabId, leafId, paneKey } = created.results[0]!
  const split = build(
    context,
    [{ type: 'splitPane', workspace: WS, tabId: tabId!, leafId: leafId!, direction: 'vertical' }],
    created.model
  )
  const started = applyLayoutTransition(split.model, {
    type: 'processStarted',
    workspace: WS,
    paneKey: paneKey!,
    ptyId: 'pty-worker',
    incarnationId: 'inc-1'
  })
  if (!started.ok) {
    throw new Error(started.code)
  }
  const workspace = started.model.workspaces[WS]!
  const model: WorkspaceLayoutModel = {
    ...started.model,
    workspaces: {
      [WS]: {
        ...workspace,
        leaves: {
          ...workspace.leaves,
          [leafId!]: { ...workspace.leaves?.[leafId!], sleeping: SLEEPING }
        }
      }
    }
  }
  const surface = {
    worktreeId: WS,
    terminalTabId: tabId!,
    leafId: leafId!,
    ptyId: 'pty-worker',
    incarnationId: 'inc-1'
  }
  return { model, tabId: tabId!, leafId: leafId!, surface }
}

function recovered(...args: Parameters<typeof recoverLegacyWorker>): WorkspaceLayoutModel {
  const result = recoverLegacyWorker(...args)
  if (!result.ok) {
    throw new Error(result.code)
  }
  return result.model
}

const leafOf = (model: WorkspaceLayoutModel, leafId: string) =>
  model.workspaces[WS]?.leaves?.[leafId]

describe('legacy worker recovery', () => {
  it('drops an adopted worker’s sleeping record and keeps its pane', () => {
    const { model, tabId, leafId, surface } = setup()

    const next = recovered(model, surface, 'adopted')

    expect(leafOf(next, leafId)).toEqual({ ptyId: 'pty-worker', incarnationId: 'inc-1' })
    expect(terminalTab(next, tabId).panes.root).toEqual(terminalTab(model, tabId).panes.root)
  })

  it('retires an exited worker’s pane and drops its record', () => {
    const { model, tabId, leafId, surface } = setup()

    const next = recovered(model, surface, 'exited')

    expect(leafOf(next, leafId)).toBeUndefined()
    expect(terminalTab(next, tabId).panes.root).toMatchObject({ type: 'leaf' })
    expect(terminalTab(next, tabId).panes.root).not.toMatchObject({ leafId })
  })

  it('keeps a pane that now shows another incarnation of the terminal', () => {
    const { model, tabId, leafId, surface } = setup()

    const next = recovered(model, { ...surface, incarnationId: 'inc-old' }, 'exited')

    expect(leafOf(next, leafId)?.incarnationId).toBe('inc-1')
    expect(terminalTab(next, tabId).panes.root).toEqual(terminalTab(model, tabId).panes.root)
  })

  it('leaves the model alone for a tab the layout no longer has', () => {
    const { model, surface } = setup()

    expect(recovered(model, { ...surface, terminalTabId: 'gone' }, 'adopted')).toBe(model)
  })
})
