import type { RpcResponse } from './types'

const RENDERER_UNAVAILABLE = 'renderer_unavailable'

/** A host with no renderer (a headless `orca serve`) refusing a call that needs a desktop window. */
export function isRendererUnavailableReply(response: RpcResponse): boolean {
  return (
    !response.ok &&
    (response.error.code === RENDERER_UNAVAILABLE ||
      (response.error.code === 'runtime_error' && response.error.message === RENDERER_UNAVAILABLE))
  )
}
