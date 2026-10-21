import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setupLayoutOwnerRuntime, WORKTREE_ID } from '../../orca-runtime-layout-owner-start-fixture'
import type { TerminalCreateOptions } from '../../runtime-terminal-contracts'
import { markAgentLaunchesClosedByUser } from '../../../agent-launch/agent-launch-pane-attachment'
import { startWindowTabWithInputs } from './window-tab-start-inputs'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const TAB_ID = 'window-tab'
const LEAF_ID = '33333333-3333-4333-8333-333333333333'
const PANE = { tabId: TAB_ID, leafId: LEAF_ID }
const TELEMETRY = {
  agent_kind: 'claude-code',
  launch_source: 'tab_bar_quick_launch',
  request_kind: 'new'
} as const
const CLAUDE_LAUNCH = {
  launch: { agent: 'claude', target: { kind: 'existing', worktree: `id:${WORKTREE_ID}` } }
}

function setup() {
  const fixture = setupLayoutOwnerRuntime()
  const { runtime } = fixture
  const verdicts: unknown[] = []
  vi.spyOn(runtime, 'reportAgentLaunchPaneVerdict').mockImplementation((_pane, verdict) => {
    verdicts.push(verdict)
  })
  const plan = vi.fn(async (_workspace: unknown, opts: TerminalCreateOptions) =>
    opts.startupAgent
      ? {
          ...opts,
          command: "claude --planned 'x'",
          launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
          launchAgent: opts.startupAgent,
          telemetry: TELEMETRY
        }
      : opts
  )
  const pasteDraft = vi.fn()
  Object.assign(runtime, {
    showTerminalWorkspaceLaunchScope: async () => ({
      id: WORKTREE_ID,
      path: '/workspace',
      connectionId: null
    }),
    resolveAgentTerminalCreateOptions: plan,
    pasteStartupDraftWhenReady: pasteDraft
  })
  return { ...fixture, verdicts, plan, pasteDraft }
}

async function windowTab(runtime: ReturnType<typeof setupLayoutOwnerRuntime>['runtime']) {
  const reply = await runtime.applyLayoutCommand({
    type: 'createTerminalTab',
    workspace: WORKTREE_ID,
    ...PANE
  })
  expect(reply.ok).toBe(true)
}

describe("the start inputs of the window's new tab, run by main (L252)", () => {
  let fixture: ReturnType<typeof setup>
  beforeEach(async () => {
    fixture = setup()
    await windowTab(fixture.runtime)
  })

  it('hands the spawn its telemetry, which main records once it commits', async () => {
    await fixture.runtime.startWindowTabTerminal(WORKTREE_ID, PANE, {
      command: 'claude',
      telemetry: TELEMETRY
    })

    expect(fixture.spawn.mock.calls[0]![0]).toMatchObject({ telemetry: TELEMETRY })
  })

  it("plans the pane's agent launch, starts the planned command and says it proceeded", async () => {
    await fixture.runtime.startWindowTabTerminal(WORKTREE_ID, PANE, {
      // What the pane's own spawn would have run is replaced by the plan, as there.
      command: '',
      launchAgent: 'claude',
      agentLaunch: CLAUDE_LAUNCH
    })

    expect(fixture.plan.mock.calls[0]![1]).toMatchObject({ startupAgent: 'claude' })
    expect(fixture.spawn).toHaveBeenCalledTimes(1)
    expect(fixture.spawn.mock.calls[0]![0]).toMatchObject({
      command: "claude --planned 'x'",
      launchAgent: 'claude',
      telemetry: TELEMETRY,
      env: expect.objectContaining({ ORCA_AGENT_LAUNCH_TOKEN: expect.any(String) })
    })
    expect(fixture.verdicts).toEqual([{ kind: 'proceed' }])
  })

  it('starts no shell when the plan fails, and the pane says why', async () => {
    fixture.plan.mockRejectedValueOnce(new Error('Could not build launch command for claude.'))

    await expect(
      fixture.runtime.startWindowTabTerminal(WORKTREE_ID, PANE, { agentLaunch: CLAUDE_LAUNCH })
    ).rejects.toThrow('Could not build launch command for claude.')

    expect(fixture.spawn).not.toHaveBeenCalled()
    expect(fixture.runtime.startStatusOf(`${TAB_ID}:${LEAF_ID}`)).toMatchObject({
      status: 'failed'
    })
    expect(fixture.verdicts).toEqual([{ kind: 'not-started', code: expect.any(String) }])
  })

  it('starts nothing in a pane the user closed while it was planned', async () => {
    fixture.plan.mockImplementationOnce(async (_workspace, opts) => {
      markAgentLaunchesClosedByUser(WORKTREE_ID, { kind: 'tab', tabId: TAB_ID })
      return { ...opts, command: 'claude', launchAgent: 'claude' }
    })

    await expect(
      fixture.runtime.startWindowTabTerminal(WORKTREE_ID, PANE, { agentLaunch: CLAUDE_LAUNCH })
    ).rejects.toThrow()

    expect(fixture.spawn).not.toHaveBeenCalled()
    // Withdrawn by the user's close, which the window already applied: nothing is reported.
    expect(fixture.verdicts).toEqual([])
  })

  it('refuses a launch request that names another workspace, starting nothing', async () => {
    Object.assign(fixture.runtime, {
      showTerminalWorkspaceLaunchScope: async () => ({ id: 'repo-1::/other', path: '/other' })
    })

    await expect(
      fixture.runtime.startWindowTabTerminal(WORKTREE_ID, PANE, { agentLaunch: CLAUDE_LAUNCH })
    ).rejects.toThrow('agent_launch_request_invalid')
    expect(fixture.spawn).not.toHaveBeenCalled()
  })

  it('pastes a draft its agent takes only once ready, once, from main', async () => {
    const created = await fixture.runtime.startWindowTabTerminal(WORKTREE_ID, PANE, {
      command: 'codex',
      launchAgent: 'codex',
      draftPaste: { agent: 'codex', content: 'look at this' }
    })

    expect(fixture.pasteDraft.mock.calls).toEqual([
      [created.handle, { agent: 'codex', content: 'look at this' }]
    ])
  })

  it('pastes nothing into a terminal it attached to instead of starting', async () => {
    const pasteDraft = vi.fn()
    await startWindowTabWithInputs(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the attach path reads no host member.
      { runtime: fixture.runtime as never, store: null, pasteDraft },
      { worktreeId: WORKTREE_ID, ...PANE },
      { command: 'codex', draftPaste: { agent: 'codex', content: 'look' } },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the reply's handle and reattach flag are read.
      async () => ({ handle: 'term-1', isReattach: true }) as never
    )

    expect(pasteDraft).not.toHaveBeenCalled()
  })
})
