import { useCallback, useLayoutEffect, useRef } from 'react'

/** Local effects belong to the committed owner; capture once before awaiting. */
export function useCommittedOperationOwnership(owner: object): () => () => boolean {
  const currentOwner = useRef<object | null>(owner)
  useLayoutEffect(() => {
    currentOwner.current = owner
    return () => {
      currentOwner.current = null
    }
  }, [owner])
  return useCallback(() => () => currentOwner.current === owner, [owner])
}
