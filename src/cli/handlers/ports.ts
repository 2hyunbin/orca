import type { RuntimeWorktreeRecord } from '../../shared/runtime-types'
import type { WorkspacePortHostScanResult } from '../../shared/workspace-ports'
import { resolveCurrentAgentWorkspaceSelector } from '../agent-workspace-selector'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { getOptionalStringFlag } from '../flags'
import { printResult } from '../format'
import { formatPortsScan } from '../ports-format'
import { RuntimeClientError, type RuntimeRpcSuccess } from '../runtime-client'
import { normalizeWorktreeSelectorForCaller } from '../selectors'

type PortsTarget = { selector: string; worktreePath: string | null }

// Why: Orca ties listeners only to repo-backed workspaces, so a native folder shows its host's listeners.
function isNativeFolderSelector(selector: string): boolean {
  return (selector.startsWith('id:') ? selector.slice(3) : selector).startsWith('folder:')
}

export async function resolvePortsTarget(
  ctx: Pick<HandlerContext, 'flags' | 'cwd' | 'client'>,
  options: { needsWorktreePath: boolean }
): Promise<PortsTarget> {
  const { flags, cwd, client } = ctx
  const explicit = getOptionalStringFlag(flags, 'worktree')
  const selector =
    !explicit || explicit === 'active' || explicit === 'current'
      ? await resolveCurrentAgentWorkspaceSelector(cwd, client)
      : await normalizeWorktreeSelectorForCaller(explicit, cwd, client)
  if (!options.needsWorktreePath || isNativeFolderSelector(selector)) {
    return { selector, worktreePath: null }
  }
  const shown = await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', {
    worktree: selector
  })
  return { selector, worktreePath: shown.result.worktree.git.path }
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

// Why the path, not the id: folder workspace instances share one path, and attribution names only
// the first of them as owner.
export function selectWorkspacePorts(
  scan: WorkspacePortHostScanResult,
  worktreePath: string | null
): WorkspacePortHostScanResult {
  const ports = scan.ports
    .filter(
      (port) =>
        worktreePath === null || (port.kind === 'workspace' && port.owner.path === worktreePath)
    )
    .sort((a, b) => a.port - b.port || (a.processName ?? '').localeCompare(b.processName ?? ''))
  return { ...scan, ports }
}

export const PORTS_HANDLERS: Record<string, CommandHandler> = {
  ports: async ({ flags, client, cwd, json }) => {
    const all = flags.get('all') === true
    const target = await resolvePortsTarget({ flags, cwd, client }, { needsWorktreePath: !all })
    const response = await scanPortsOnWorkspaceHost(client, target.selector)
    const worktreePath = all ? null : target.worktreePath
    const result = selectWorkspacePorts(response.result, worktreePath)
    printResult({ ...response, result }, json, (scan) =>
      formatPortsScan(scan, { showOwner: worktreePath === null })
    )
  }
}
