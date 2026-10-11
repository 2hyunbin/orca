import { useCallback, useLayoutEffect, useRef } from 'react'
import type { RpcClient } from './rpc-client'

type MobileOperationOwner = {
  readonly hostId: string
  readonly worktreeId: string
  readonly client: RpcClient | null
}

/** Local effects belong to the committed owner; capture once before awaiting. */
export function useCommittedOperationOwnership(owner: MobileOperationOwner): () => () => boolean {
  const currentOwner = useRef<MobileOperationOwner | null>(owner)
  useLayoutEffect(() => {
    currentOwner.current = owner
    return () => {
      currentOwner.current = null
    }
  }, [owner])
  return useCallback(() => () => currentOwner.current === owner, [owner])
}
