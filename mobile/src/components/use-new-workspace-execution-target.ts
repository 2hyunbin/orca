import { useEffect, useState } from 'react'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import type { RpcClient } from '../transport/rpc-client'
import {
  localAgentDetectionRead,
  remoteAgentDetectionRead,
  sshRepoConnectRun,
  sshRepoStateRead
} from '../tasks/mobile-workspace-source-operations'
import {
  deriveWorkspaceSshGate,
  type WorkspaceSshGate,
  type WorkspaceSshRecord
} from '../tasks/workspace-ssh-gate'

type DetectedAgentIdsState = {
  target: string
  ids: Set<string>
}

type SshStateEntry = {
  target: string
  record: WorkspaceSshRecord
}

function fallbackSshState(
  targetId: string,
  status: WorkspaceSshRecord['status'],
  error: string | null
): WorkspaceSshRecord {
  return { targetId, status, error, reconnectAttempt: 0 }
}

export function useNewWorkspaceExecutionTarget(args: {
  client: RpcClient | null
  connectionId: string | null
  /** The server the repo runs on, which holds its SSH target; undefined for the desktop's own. */
  server?: ExecutionHostId
  visible: boolean
}): {
  sshGate: WorkspaceSshGate
  detectedAgentIds: Set<string> | null
  connect: () => Promise<void>
} {
  const { client, connectionId, server, visible } = args
  // Why the host too: the desktop and a server can each hold a target with the same id.
  const target = JSON.stringify([server ?? null, connectionId])
  const [sshState, setSshEntry] = useState<SshStateEntry | null>(null)
  const setSshState = (record: WorkspaceSshRecord) => setSshEntry({ target, record })
  const [connectingTarget, setConnectingTarget] = useState<string | null>(null)
  const [detectedAgentIdsState, setDetectedAgentIdsState] = useState<DetectedAgentIdsState | null>(
    null
  )
  const sshGate = deriveWorkspaceSshGate({
    connectionId,
    state: sshState?.target === target ? sshState.record : null,
    connecting: connectingTarget === target
  })
  const detectedAgentIds =
    detectedAgentIdsState?.target === target &&
    (connectionId === null || sshGate.status === 'connected')
      ? detectedAgentIdsState.ids
      : null

  useEffect(() => {
    if (!visible || !client || !connectionId) {
      return
    }
    let stale = false
    void sshRepoStateRead
      .request(client, { targetId: connectionId })
      .then((reply) => {
        if (stale) {
          return
        }
        const state = sshRepoStateRead.interpret(reply)
        setSshState(state ?? fallbackSshState(connectionId, 'disconnected', null))
      })
      .catch((error) => {
        if (!stale) {
          setSshState(
            fallbackSshState(
              connectionId,
              'error',
              error instanceof Error ? error.message : 'Failed to read SSH connection state.'
            )
          )
        }
      })
    return () => {
      stale = true
    }
  }, [client, target, visible])

  useEffect(() => {
    if (!visible || !client || (connectionId && sshGate.status !== 'connected')) {
      return
    }
    let stale = false
    void (async () => {
      try {
        const detected = connectionId
          ? remoteAgentDetectionRead.interpret(
              await remoteAgentDetectionRead.request(client, { connectionId })
            )
          : localAgentDetectionRead.interpret(await localAgentDetectionRead.request(client))
        if (!stale) {
          setDetectedAgentIdsState({
            target,
            ids: detected.accepted ? new Set(detected.value) : new Set()
          })
        }
      } catch {
        if (!stale) {
          setDetectedAgentIdsState({ target, ids: new Set() })
        }
      }
    })()
    return () => {
      stale = true
    }
  }, [client, target, sshGate.status, visible])

  async function connect(): Promise<void> {
    if (!client || !connectionId) {
      return
    }
    setConnectingTarget(target)
    setSshState(fallbackSshState(connectionId, 'connecting', null))
    try {
      const reply = await sshRepoConnectRun.request(
        client,
        { targetId: connectionId },
        { timeoutMs: 120_000 }
      )
      const state = sshRepoConnectRun.interpret(reply)
      setSshState(state ?? fallbackSshState(connectionId, 'connected', null))
    } catch (error) {
      setSshState(
        fallbackSshState(
          connectionId,
          'error',
          error instanceof Error ? error.message : 'Failed to connect to SSH repository.'
        )
      )
    } finally {
      setConnectingTarget((current) => (current === target ? null : current))
    }
  }

  return { sshGate, detectedAgentIds, connect }
}
