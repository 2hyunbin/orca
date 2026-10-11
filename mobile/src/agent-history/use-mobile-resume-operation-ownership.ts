import { useCallback, useMemo } from 'react'
import { useCommittedOperationOwnership } from '../transport/use-committed-operation-ownership'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'

export function useMobileResumeOperationOwnership(
  hostId: string,
  worktreeId: string,
  client: RpcClient | null,
  connection: ConnectionState
) {
  const generation = client?.getGeneration?.()
  const owner = useMemo(
    () => ({ hostId, worktreeId, client, connection, generation }),
    [hostId, worktreeId, client, connection, generation]
  )
  const captureOwnership = useCommittedOperationOwnership(owner)
  return useCallback(() => {
    const isCurrentOwner = captureOwnership()
    return () => {
      if (
        !isCurrentOwner() ||
        owner.connection !== 'connected' ||
        !owner.client ||
        owner.client.getState() !== 'connected' ||
        owner.client.getGeneration?.() !== owner.generation
      ) {
        throw new Error('Host connection changed. Retry resume.')
      }
    }
  }, [captureOwnership, owner])
}
