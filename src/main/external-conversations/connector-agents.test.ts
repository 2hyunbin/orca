import { describe, expect, it } from 'vitest'
import { admitConnectorAgent, connectorAgentArgs } from './connector-agents'

describe('connectorAgentArgs', () => {
  it('asks for approval even with no Arguments, where the legacy default would skip it', () => {
    expect(connectorAgentArgs('claude', {})).toBe('--permission-mode default')
    expect(connectorAgentArgs('codex', {})).toBe(
      '-a on-request -s workspace-write -c approvals_reviewer=user'
    )
  })

  it("keeps the user's own Arguments behind the Ask recipe", () => {
    expect(connectorAgentArgs('claude', { agentDefaultArgs: { claude: '--model opus' } })).toBe(
      '--permission-mode default --model opus'
    )
  })

  it.each([
    ['claude', '--dangerously-skip-permissions --model opus'],
    ['claude', '--allow-dangerously-skip-permissions'],
    ['claude', '--permission-mode bypassPermissions'],
    ['codex', '--dangerously-bypass-approvals-and-sandbox'],
    ['codex', '--yolo'],
    ['codex', '--full-auto'],
    ['codex', '-c approval_policy=never']
  ] as const)('drops %s Arguments that set permissions (%s)', (agent, own) => {
    expect(connectorAgentArgs(agent, { agentDefaultArgs: { [agent]: own } })).toBe(
      connectorAgentArgs(agent, {})
    )
  })
})

describe('admitConnectorAgent', () => {
  it('refuses an agent whose own Command skips approvals, since Arguments cannot undo that', () => {
    expect(admitConnectorAgent({}, 'claude')).toBe(true)
    expect(
      admitConnectorAgent(
        { agentCmdOverrides: { claude: 'claude --dangerously-skip-permissions' } },
        'claude'
      )
    ).toBe(false)
    expect(admitConnectorAgent({ agentCmdOverrides: { codex: '/opt/codex' } }, 'codex')).toBe(true)
  })
})
