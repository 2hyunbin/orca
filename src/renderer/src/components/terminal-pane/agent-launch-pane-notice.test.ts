import { describe, expect, it, vi } from 'vitest'

const CATALOG: Record<string, string> = {
  'auto.components.terminal.pane.AgentLaunchPaneNotice.agent': '智能体',
  'auto.components.terminal.pane.AgentLaunchPaneNotice.notStarted': '无法启动 {{agent}}。',
  'auto.components.terminal.pane.AgentLaunchPaneNotice.unconfirmed':
    '无法确认 {{agent}} 已启动。请先检查其终端，再重试。',
  'auto.components.terminal.pane.AgentLaunchPaneNotice.exitedDuringStart':
    '{{agent}} 在启动时退出了。',
  'auto.components.terminal.pane.AgentLaunchPaneNotice.workspaceGone':
    '{{agent}} 的工作区已不可用，无法启动。',
  'auto.components.terminal.pane.AgentLaunchPaneNotice.restoreWorkspace':
    '请恢复工作区文件夹或打开可用的工作区，然后重试。',
  'auto.components.terminal.pane.AgentLaunchPaneNotice.tryInTerminal':
    '请在此文件夹的终端中运行它以查看原因，然后重试。'
}
vi.mock('@/i18n/i18n', () => ({
  translate: (key: string, fallback: string, options?: { agent?: string }) =>
    (CATALOG[key] ?? fallback).replaceAll('{{agent}}', options?.agent ?? '')
}))

const { agentLaunchErrorText, agentLaunchPaneNoticeText, agentLaunchPaneOutcomeForLeaf } =
  await import('./agent-launch-pane-notice-text')

describe("the pane of a launch whose agent isn't running", () => {
  it("says it couldn't start, in the viewer's language, with a reason they can act on", () => {
    expect(
      agentLaunchPaneNoticeText(
        { kind: 'not-started', code: 'agent_session_exited_during_start' },
        'claude'
      )
    ).toBe('Claude 在启动时退出了。 请在此文件夹的终端中运行它以查看原因，然后重试。')
  })

  it('offers a possible workspace remedy on both startup surfaces when the folder is missing', () => {
    const expected =
      'Codex 的工作区已不可用，无法启动。 请恢复工作区文件夹或打开可用的工作区，然后重试。'
    expect(
      agentLaunchPaneNoticeText({ kind: 'not-started', code: 'worktree_not_found' }, 'codex')
    ).toBe(expected)
    expect(agentLaunchErrorText('worktree_not_found', 'codex')).toBe(expected)
  })

  it('never shows a host error code', () => {
    expect(
      agentLaunchPaneNoticeText({ kind: 'not-started', code: 'agent_launch_pane_already_live' })
    ).toBe('无法启动 智能体。 请在此文件夹的终端中运行它以查看原因，然后重试。')
  })

  it("says it can't confirm, never that it failed, when nobody knows", () => {
    expect(agentLaunchPaneNoticeText({ kind: 'unconfirmed' })).toBe(
      '无法确认 智能体 已启动。请先检查其终端，再重试。'
    )
  })
})

describe('which pane shows it', () => {
  const outcome = { kind: 'not-started' as const, code: 'boom' }
  const tab = { agentLaunchPane: { leafId: 'leaf-1', outcome } }

  it('the leaf the launch laid out, once its fate is final', () => {
    expect(agentLaunchPaneOutcomeForLeaf(tab, 'leaf-1')).toEqual(outcome)
    expect(agentLaunchPaneOutcomeForLeaf(tab, 'leaf-2')).toBeNull()
    expect(
      agentLaunchPaneOutcomeForLeaf({ agentLaunchPane: { leafId: 'leaf-1' } }, 'leaf-1')
    ).toBeNull()
    expect(agentLaunchPaneOutcomeForLeaf(undefined, 'leaf-1')).toBeNull()
  })
})
