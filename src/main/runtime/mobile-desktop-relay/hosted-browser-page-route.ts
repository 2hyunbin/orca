import { z } from 'zod'
import type { RpcRequest } from '../rpc/core'
import { browserScreencastSubscriptionPageId } from '../browser-screencast-subscription-id'

const BrowserCallParams = z.looseObject({
  page: z.string().optional(),
  subscriptionId: z.string().optional()
})

/**
 * The call rewritten for this desktop's own runtime when the page it targets is a client-placed
 * page this desktop renders for that server, or null when the call belongs to the server.
 */
// Why: the server cannot screencast a page it does not render, so the desktop serves it as its renderer does.
export function localHostedBrowserPageRequest(
  request: RpcRequest,
  environmentId: string,
  hostsBrowserPage: (environmentId: string, browserPageId: string) => boolean
): RpcRequest | null {
  if (!request.method.startsWith('browser.')) {
    return null
  }
  const parsed = BrowserCallParams.safeParse(request.params)
  if (!parsed.success) {
    return null
  }
  const { worktree: _serverSelector, ...params } = parsed.data
  const page =
    request.method === 'browser.screencast.unsubscribe'
      ? browserScreencastSubscriptionPageId(params.subscriptionId ?? '')
      : params.page || null
  if (page === null || !hostsBrowserPage(environmentId, page)) {
    return null
  }
  // Why: the selector names the server's workspace, which this desktop cannot resolve; the page id is stable.
  return { ...request, params }
}
