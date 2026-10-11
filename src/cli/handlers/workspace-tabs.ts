import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-types'
import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { getBrowserWorktreeSelector } from '../selectors'
import {
  formatWorkspaceTabList,
  projectWorkspaceTabRows,
  type WorkspaceTabListResult
} from '../workspace-tab-rows'

export const WORKSPACE_TAB_HANDLERS: Record<string, CommandHandler> = {
  'tab list': async ({ flags, client, cwd, json }) => {
    const worktree = await getBrowserWorktreeSelector(flags, cwd, client)
    const response = worktree
      ? await client.call<RuntimeMobileSessionTabsResult>('session.tabs.list', { worktree })
      : await client.call<{ snapshots: RuntimeMobileSessionTabsResult[] }>('session.tabs.listAll')
    const snapshots = 'snapshots' in response.result ? response.result.snapshots : [response.result]
    const result: WorkspaceTabListResult = { tabs: snapshots.flatMap(projectWorkspaceTabRows) }
    printResult({ ...response, result }, json, formatWorkspaceTabList)
  }
}
