import { describe, expect, it } from 'vitest'
import { resolveResumeLaunchRecipe, withResumeArguments } from './tui-agent-launch-defaults'
import { buildAgentResumeStartupPlan } from './tui-agent-resume-startup'

const providerSession = { key: 'session_id', id: 's1' } as const

function resumeCommand(agent: 'claude' | 'codex', recorded: string, agentArgs: string) {
  const captured = {
    agentCommand: `${agent} ${recorded}`,
    agentArgs: recorded,
    agentEnv: { A: '1' }
  }
  const recipe = resolveResumeLaunchRecipe(withResumeArguments(captured, agentArgs))
  expect(recipe.agentEnv).toEqual({ A: '1' })
  const plan = buildAgentResumeStartupPlan({
    agent,
    providerSession,
    cmdOverrides: {},
    platform: 'linux',
    ...recipe
  })
  return plan?.launchCommand ?? ''
}

describe('withResumeArguments', () => {
  it.each([
    ['claude', '--dangerously-skip-permissions', '--permission-mode default'],
    ['codex', '--dangerously-bypass-approvals-and-sandbox', '-a on-request -s workspace-write']
  ] as const)('rebuilds a captured %s command with the new Arguments only', (agent, old, args) => {
    const command = resumeCommand(agent, old, args)
    expect(command).not.toContain('dangerously')
    expect(command).toContain(args.split(' ')[0])
  })
})
