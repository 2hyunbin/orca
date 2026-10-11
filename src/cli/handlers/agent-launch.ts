import type { CommandHandler } from '../dispatch'
import {
  callAgentLaunch,
  formatAgentLaunch,
  hostRunsAgentLaunch,
  parseCliAgent,
  readCliAgentLaunch
} from '../agent-launch-request'
import { getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import { getRequiredWorktreeSelector, resolveCurrentWorktreeSelector } from '../selectors'

export const AGENT_LAUNCH_HANDLERS: Record<string, CommandHandler> = {
  'agent launch': async ({ flags, client, cwd, json }) => {
    const launch = readCliAgentLaunch(flags, parseCliAgent(getRequiredStringFlag(flags, 'agent')), {
      createsWorktree: false
    })
    if (client.isRemote && !flags.has('worktree')) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Remote agent launch requires --worktree because the client cwd cannot identify a server worktree.'
      )
    }
    const worktree = flags.has('worktree')
      ? await getRequiredWorktreeSelector(flags, 'worktree', cwd, client)
      : await resolveCurrentWorktreeSelector(cwd, client)
    if (!(await hostRunsAgentLaunch(client))) {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'This Orca host cannot start agents from the CLI. Update Orca on the execution host.'
      )
    }
    const result = await callAgentLaunch(client, launch, {
      target: { kind: 'existing', worktree },
      presentation: flags.get('focus') === true ? 'focused' : 'background'
    })
    printResult(result, json, formatAgentLaunch)
  }
}
