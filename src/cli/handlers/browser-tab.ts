import type {
  BrowserTabCurrentResult,
  BrowserTabShowResult,
  BrowserTabSwitchResult
} from '../../shared/runtime-types'
import type { CommandHandler } from '../dispatch'
import { formatTabShow, printResult } from '../format'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { getBrowserCommandTarget, getBrowserWorktreeSelector } from '../selectors'

export const BROWSER_TAB_HANDLERS: Record<string, CommandHandler> = {
  'open-url': async ({ flags, client, cwd, json }) => {
    const url = getRequiredStringFlag(flags, 'url')
    const worktree = await getBrowserWorktreeSelector(flags, cwd, client)
    const result = await client.call<{ browserPageId: string }>(
      'browser.openUrl',
      { url, worktree },
      { timeoutMs: 60_000 }
    )
    printResult(result, json, (v) => `Opened URL in tab ${v.browserPageId}`)
  },
  'browser page show': async ({ flags, client, cwd, json }) => {
    const target = await getBrowserCommandTarget(flags, cwd, client)
    const result = await client.call<BrowserTabShowResult>('browser.tabShow', target)
    printResult(result, json, formatTabShow)
  },
  'browser page current': async ({ flags, client, cwd, json }) => {
    const worktree = await getBrowserWorktreeSelector(flags, cwd, client)
    const result = await client.call<BrowserTabCurrentResult>('browser.tabCurrent', { worktree })
    printResult(result, json, formatTabShow)
  },
  'tab switch': async ({ flags, client, cwd, json }) => {
    const page = getRequiredStringFlag(flags, 'page')
    // Why: a stable browser page id is globally unique across Orca, so page-
    // targeted tab switches should match the rest of the --page command model:
    // global by default, with --worktree only acting as explicit validation.
    const target = await getBrowserCommandTarget(flags, cwd, client)
    // Why: --focus is an opt-in side effect. The renderer's handler is
    // worktree-scoped: it surfaces the browser pane only when the user is
    // already on the targeted worktree, otherwise it pre-stages silently.
    // Spread conditionally so the RPC payload stays shape-identical to the
    // pre-flag form when --focus is absent.
    const result = await client.call<BrowserTabSwitchResult>('browser.tabSwitch', {
      page,
      ...(flags.has('focus') ? { focus: true } : {}),
      ...target
    })
    printResult(result, json, (v) => `Switched to tab ${v.switched} (${v.browserPageId})`)
  },
  'browser page create': async ({ flags, client, cwd, json }) => {
    const url = getOptionalStringFlag(flags, 'url')
    const profileId = getOptionalStringFlag(flags, 'profile')
    const worktree = await getBrowserWorktreeSelector(flags, cwd, client)
    const result = await client.call<{ browserPageId: string }>(
      'browser.tabCreate',
      { url, worktree, profileId },
      { timeoutMs: 60_000 }
    )
    printResult(result, json, (v) => `Created tab ${v.browserPageId}`)
  },
  'tab close': async ({ flags, client, cwd, json }) => {
    const target = await getBrowserCommandTarget(flags, cwd, client)
    const result = await client.call<{ closed: boolean }>('browser.tabClose', target)
    printResult(result, json, () => 'Tab closed')
  },
  exec: async ({ flags, client, cwd, json }) => {
    const command = getRequiredStringFlag(flags, 'command')
    const target = await getBrowserCommandTarget(flags, cwd, client)
    const result = await client.call<unknown>('browser.exec', { command, ...target })
    printResult(result, json, (v) => JSON.stringify(v, null, 2))
  }
}
