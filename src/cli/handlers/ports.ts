import type { RuntimeWorktreeRecord } from '../../shared/runtime-types'
import type { WorkspacePortHostScanResult } from '../../shared/workspace-ports'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { getOptionalStringFlag } from '../flags'
import { printResult } from '../format'
import { formatPortsScan } from '../ports-format'
import { RuntimeClientError, type RuntimeRpcSuccess } from '../runtime-client'
import { normalizeWorktreeSelectorForCaller, resolveCurrentWorktreeSelection } from '../selectors'

type PortsTarget = { selector: string; worktreeId: string | null }

// Why: Orca ties listeners only to git worktrees, so a folder workspace shows its host's listeners.
function isFolderWorkspaceSelector(selector: string): boolean {
  return (selector.startsWith('id:') ? selector.slice(3) : selector).startsWith('folder:')
}

export async function resolvePortsTarget(
  ctx: Pick<HandlerContext, 'flags' | 'cwd' | 'client'>,
  options: { needsWorktreeId: boolean }
): Promise<PortsTarget> {
  const { flags, cwd, client } = ctx
  const explicit = getOptionalStringFlag(flags, 'worktree')
  if (!explicit || explicit === 'active' || explicit === 'current') {
    const current = await resolveCurrentWorktreeSelection(cwd, client)
    return isFolderWorkspaceSelector(current.worktreeId)
      ? { selector: current.selector, worktreeId: null }
      : current
  }
  const selector = await normalizeWorktreeSelectorForCaller(explicit, cwd, client)
  if (!options.needsWorktreeId || isFolderWorkspaceSelector(selector)) {
    return { selector, worktreeId: null }
  }
  const shown = await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', {
    worktree: selector
  })
  return { selector, worktreeId: shown.result.worktree.id }
}

// Why: an older runtime has no host-scoped scan; its raw method_not_found reads as a CLI bug.
export async function scanPortsOnWorkspaceHost(
  client: Pick<HandlerContext['client'], 'call'>,
  selector: string
): Promise<RuntimeRpcSuccess<WorkspacePortHostScanResult>> {
  try {
    return await client.call<WorkspacePortHostScanResult>('workspacePorts.scanHost', {
      worktree: selector
    })
  } catch (error) {
    if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'This Orca runtime cannot list workspace ports yet. Update Orca and try again.'
      )
    }
    throw error
  }
}

export function selectWorkspacePorts(
  scan: WorkspacePortHostScanResult,
  worktreeId: string | null
): WorkspacePortHostScanResult {
  const ports = scan.ports
    .filter(
      (port) =>
        worktreeId === null || (port.kind === 'workspace' && port.owner.worktreeId === worktreeId)
    )
    .sort((a, b) => a.port - b.port || (a.processName ?? '').localeCompare(b.processName ?? ''))
  return { ...scan, ports }
}

export const PORTS_HANDLERS: Record<string, CommandHandler> = {
  ports: async ({ flags, client, cwd, json }) => {
    const all = flags.get('all') === true
    const target = await resolvePortsTarget({ flags, cwd, client }, { needsWorktreeId: !all })
    const response = await scanPortsOnWorkspaceHost(client, target.selector)
    const worktreeId = all ? null : target.worktreeId
    const result = selectWorkspacePorts(response.result, worktreeId)
    printResult({ ...response, result }, json, (scan) =>
      formatPortsScan(scan, { showOwner: worktreeId === null })
    )
  }
}
