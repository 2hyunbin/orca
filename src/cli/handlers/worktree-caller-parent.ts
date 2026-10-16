import { parseWorkspaceKey } from '../../shared/workspace-scope'
import type { ParentWorktreeRef } from '../../shared/worktree/lineage-types'
import type { RuntimeStatus, RuntimeWorktreeRecord } from '../../shared/runtime-types'
import { WORKTREE_CROSS_MACHINE_PARENT_RUNTIME_CAPABILITY } from '../../shared/runtime-capability-constants'
import { RuntimeClient, RuntimeClientError } from '../runtime-client'
import { resolveCurrentWorktreeSelector } from '../selectors'
import { getEnvParentWorkspace } from './worktree-create-parent-selector'

export async function resolveCallerParentReference(args: {
  client: RuntimeClient
  flags: Map<string, string | boolean>
  cwd: string
  infer: boolean
}): Promise<ParentWorktreeRef | undefined> {
  const selector = args.flags.get('parent-worktree')
  const explicit = selector === 'active' || selector === 'current'
  if (
    !args.client.isRemote ||
    (!explicit && (!args.infer || selector || args.flags.get('no-parent') === true))
  ) {
    return undefined
  }
  const caller = new RuntimeClient(undefined, undefined, null, null)
  const resolve = async (
    worktree: string,
    source: NonNullable<ParentWorktreeRef['capture']>['source']
  ): Promise<ParentWorktreeRef> => {
    const row = (
      await caller.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', { worktree })
    ).result.worktree
    if (!row.instanceId) {
      throw new RuntimeClientError(
        'invalid_argument',
        'The caller worktree has no instance identity.'
      )
    }
    return {
      worktreeId: row.id,
      instanceId: row.instanceId,
      origin: 'cli',
      capture: { source, confidence: explicit ? 'explicit' : 'inferred' }
    }
  }
  let ref: ParentWorktreeRef | undefined
  if (explicit) {
    ref = await resolve(await resolveCurrentWorktreeSelector(args.cwd, caller), 'explicit-cli-flag')
  } else {
    const candidates: ParentWorktreeRef[] = []
    const env = getEnvParentWorkspace()
    if (env) {
      try {
        const scope = parseWorkspaceKey(env)
        if (scope?.type === 'worktree') {
          candidates.push(await resolve(`id:${scope.worktreeId}`, 'env-workspace'))
        }
      } catch {}
    }
    if (process.env.ORCA_TERMINAL_HANDLE) {
      try {
        const terminal = await caller.call<{ terminal: { worktreeId: string } }>('terminal.show', {
          terminal: process.env.ORCA_TERMINAL_HANDLE
        })
        candidates.push(
          await resolve(`id:${terminal.result.terminal.worktreeId}`, 'terminal-context')
        )
      } catch {}
    }
    if (candidates.length === 0) {
      try {
        candidates.push(
          await resolve(await resolveCurrentWorktreeSelector(args.cwd, caller), 'cwd-context')
        )
      } catch {}
    }
    if (new Set(candidates.map((candidate) => candidate.instanceId)).size > 1) {
      console.error(
        'warning: Worktree created without nesting because caller parent contexts disagree.'
      )
      return undefined
    }
    ref = candidates[0]
  }
  if (!ref) {
    return undefined
  }
  const status = await args.client.call<RuntimeStatus>('status.get')
  if (!status.result.capabilities?.includes(WORKTREE_CROSS_MACHINE_PARENT_RUNTIME_CAPABILITY)) {
    const host = args.flags.get('host') ?? args.flags.get('environment') ?? 'the selected host'
    const message = `Orca on ${host} is too old to nest under a worktree on another machine. Update it, or pass --no-parent.`
    if (explicit) {
      throw new RuntimeClientError('incompatible_runtime', message)
    }
    console.error(`warning: ${message} Creating without a parent.`)
    return undefined
  }
  return ref
}
