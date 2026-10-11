/**
 * `worktree create --agent`: the worktree and its agent in one `agent.launch`, so the agent follows
 * the user's Chat UI setting like every other launch. A host older than `agent.launch` gets the
 * create's own startup terminal, which cannot take a model or effort.
 */

import type { AgentLaunchResult } from '../../shared/agent-launch-intent'
import type { RuntimeWorktreeCreateResult, RuntimeWorktreeRecord } from '../../shared/runtime-types'
import {
  callAgentLaunch,
  formatAgentLaunch,
  hasLaunchModelFlags,
  hostRunsAgentLaunch,
  type CliAgentLaunch
} from '../agent-launch-request'
import { formatWorktreeShow, printResult } from '../format'
import { RuntimeClientError, type RuntimeClient } from '../runtime-client'
import { printLineageSummary } from './worktree-lineage-summary'
import { printHookWarning } from './worktree-removal-warnings'
import { withSetupDecisionRecovery } from './worktree-setup-decision-recovery'

type WorktreeAgentLaunchResult = Pick<
  RuntimeWorktreeCreateResult,
  'lineage' | 'workspaceLineage'
> & {
  /** Absent only when the host could not show the worktree it just created. */
  worktree?: RuntimeWorktreeRecord
  launch: AgentLaunchResult
}

export async function createWorktreeWithAgent(args: {
  client: RuntimeClient
  flags: Map<string, string | boolean>
  create: Record<string, unknown>
  launch: CliAgentLaunch
  json: boolean
}): Promise<void> {
  const { client, flags, create, launch, json } = args
  if (!(await hostRunsAgentLaunch(client))) {
    if (hasLaunchModelFlags(flags)) {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'This Orca host cannot start an agent on a chosen model or effort. Update Orca on the execution host, or omit --model and --effort.'
      )
    }
    const created = await withSetupDecisionRecovery(
      client.call<RuntimeWorktreeCreateResult>('worktree.create', {
        ...create,
        startupAgent: launch.agent,
        startupPrompt: launch.prompt?.text ?? '',
        launchSource: 'cli'
      })
    )
    printHookWarning(created.result, json)
    printLineageSummary(created.result, json)
    printResult(created, json, formatWorktreeShow)
    return
  }
  const launched = await withSetupDecisionRecovery(
    callAgentLaunch(client, launch, {
      target: { kind: 'create-worktree', create },
      // As before, the agent stays in the background unless activation is explicit.
      ...(create.activate === true ? {} : { presentation: 'background' as const })
    })
  )
  const worktree = await showLaunchedWorktree(client, launched.result.worktreeId)
  const result: WorktreeAgentLaunchResult = {
    ...(worktree
      ? {
          worktree,
          lineage: worktree.lineage,
          workspaceLineage: worktree.workspaceLineage ?? null
        }
      : { lineage: null }),
    launch: launched.result
  }
  printLineageSummary(result, json)
  printResult({ ...launched, result }, json, (value) =>
    [
      ...(value.worktree ? [formatWorktreeShow({ worktree: value.worktree })] : []),
      formatAgentLaunch(value.launch)
    ].join('\n')
  )
}

/** Reporting, never a reason to fail: the agent already runs, and a retry would start a second. */
async function showLaunchedWorktree(
  client: RuntimeClient,
  worktreeId: string
): Promise<RuntimeWorktreeRecord | undefined> {
  try {
    const shown = await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', {
      worktree: `id:${worktreeId}`
    })
    return shown.result.worktree
  } catch {
    return undefined
  }
}
