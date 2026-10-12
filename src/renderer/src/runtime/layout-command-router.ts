// The one place the window sends layout and view commands (design 3.4). Store and editor actions
// call these and never ask where a workspace runs. Phase 1 sends every command to the local
// runtime; the branch for server workspaces, to the frozen adapter, lands with that adapter.

import type {
  RpcMethodName,
  RpcParams
} from '../../../shared/rpc-contract/rpc-params-catalog.generated'
import type { LayoutCommandReply } from '../../../shared/workspace-layout/workspace-layout-command-types'
import { callRuntimeRpc } from './runtime-rpc-client'

type LayoutCommandMethod = Exclude<
  Extract<RpcMethodName, `layout.${string}`>,
  'layout.subscribe' | 'layout.unsubscribe' | 'layout.getRemoteSnapshots'
>
type ViewCommandMethod = Extract<RpcMethodName, `view.${string}`>

const LOCAL_RUNTIME = { kind: 'local' } as const

/** Replies once the runtime applied or refused it; the window draws the result from the stream. */
export function sendLayoutCommand<Method extends LayoutCommandMethod>(
  method: Method,
  params: RpcParams<Method>
): Promise<LayoutCommandReply> {
  return callRuntimeRpc<LayoutCommandReply>(LOCAL_RUNTIME, method, params)
}

export function sendViewCommand<Method extends ViewCommandMethod>(
  method: Method,
  params: RpcParams<Method>
): Promise<{ ok: true }> {
  return callRuntimeRpc<{ ok: true }>(LOCAL_RUNTIME, method, params)
}
