import type { RemoteRuntimeTerminalCreateIdempotency } from '../../remote-runtime-terminal-create-idempotency'
import type { RuntimeTerminalCreate } from '../../../../shared/runtime-types'
import { deriveRemoteRuntimeTerminalCreateHandle } from '../../remote-runtime-terminal-create-identity'
import { withTimeoutResult } from '../../runtime-async-boundaries'
import { PTY_CONTROLLER_LIST_TIMEOUT_MS } from '../../orca-runtime-postlude'
import { inferWorktreeIdFromPtyId } from '../../runtime-worktree-path-identity'
import { getRegisteredSshState } from '../../../ssh/ssh-target-registry'
import {
  getConnectionExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  toSshExecutionHostId
} from '../../../../shared/execution-host'
import type { RuntimePtyWorktreeRecord } from '../../runtime-terminal-state-records'
import type { Worktree } from '../../../../shared/worktree/types'
import type { TerminalWorkspaceLaunchScope } from '../../runtime-legacy-worker-terminal-recovery-types'
import type { RuntimePtyController } from '../../runtime-pty-controller-contract'

export type RuntimeTerminalCreateIdentityHost = {
  getTerminalCreateIdempotency(): RemoteRuntimeTerminalCreateIdempotency
  reconcileRemoteTerminalCreate(): RuntimeTerminalCreateIdentity['reconcileRemoteTerminalCreate']
  resolveTerminalWorkspaceLaunchScope(): (
    selector: string,
    createdWorktree?: Worktree
  ) => Promise<TerminalWorkspaceLaunchScope>
  getPtyController(): RuntimePtyController | null
  adoptControllerTerminalHandle(): (
    ptyId: string,
    handle: string | undefined,
    incarnationId?: string,
    options?: { exactRestoredSurface?: boolean }
  ) => void
  recordPtyWorktree(): (
    ptyId: string,
    worktreeId: string,
    state?: Partial<
      Pick<
        RuntimePtyWorktreeRecord,
        | 'connected'
        | 'lastOutputAt'
        | 'preview'
        | 'tabId'
        | 'paneKey'
        | 'surfaceRecordedAtGraphSequence'
        | 'title'
        | 'connectionId'
        | 'runtimeSessionOwned'
        | 'isWsl'
        | 'wslDistro'
        | 'incarnationId'
        | 'agentSessionOwners'
      >
    >
  ) => RuntimePtyWorktreeRecord
  issuePtyHandle(): (pty: RuntimePtyWorktreeRecord) => string
  getPtysById(): ReadonlyMap<string, RuntimePtyWorktreeRecord>
}

export class RuntimeTerminalCreateIdentity {
  constructor(private readonly host: RuntimeTerminalCreateIdentityHost) {}
  private get terminalCreateIdempotency() {
    return this.host.getTerminalCreateIdempotency()
  }
  private get ptyController() {
    return this.host.getPtyController()
  }
  async dedupeTerminalCreate(
    clientIdentity: string,
    worktreeSelector: string | undefined,
    clientMutationId: string | undefined,
    reconcileExisting: boolean,
    run: (
      canonicalWorktreeSelector: string | undefined,
      preAllocatedHandle: string | undefined
    ) => Promise<RuntimeTerminalCreate>
  ): Promise<RuntimeTerminalCreate> {
    if (!clientMutationId || !worktreeSelector) {
      if (reconcileExisting) {
        throw new Error('runtime_unavailable')
      }
      return await run(worktreeSelector, undefined)
    }
    const workspace = await this.host.resolveTerminalWorkspaceLaunchScope()(worktreeSelector)
    const canonicalWorktreeSelector = `id:${workspace.id}`
    const preAllocatedHandle = deriveRemoteRuntimeTerminalCreateHandle(
      clientIdentity,
      workspace.id,
      clientMutationId
    )
    return this.terminalCreateIdempotency.run(
      clientIdentity,
      workspace.id,
      clientMutationId,
      async () => {
        if (reconcileExisting) {
          const adopted = await this.host.reconcileRemoteTerminalCreate()(
            workspace.id,
            preAllocatedHandle,
            // Why: an unreachable SSH host vanishes from the aggregate listing, which would read
            // as absence and respawn over live remote work. Local/folder workspaces have no
            // connection and keep the aggregate listing.
            workspace.connectionId ?? null
          )
          if (adopted) {
            return adopted
          }
        }
        return await run(canonicalWorktreeSelector, preAllocatedHandle)
      }
    )
  }

  async reconcileRemoteTerminalCreate(
    worktreeId: string,
    terminalHandle: string,
    // Why: an aggregate listing drops a non-answering SSH host silently, which would read as
    // absence. Scoping to the owning host makes an unreachable relay throw instead.
    connectionId?: string | null
  ): Promise<RuntimeTerminalCreate | null> {
    if (!this.ptyController?.listProcesses) {
      throw new Error('runtime_unavailable')
    }
    const listed = await withTimeoutResult(
      this.ptyController.listProcesses(
        connectionId === undefined ? undefined : getConnectionExecutionHostId(connectionId)
      ),
      PTY_CONTROLLER_LIST_TIMEOUT_MS
    )
    if (!listed.ok) {
      // Why: unknown inventory cannot prove the first create failed, so spawning could duplicate a live shell.
      throw new Error('runtime_unavailable')
    }
    const matches = listed.value.filter((session) => session.terminalHandle === terminalHandle)
    if (matches.length > 1) {
      throw new Error('terminal_create_identity_conflict')
    }
    if (matches.length === 0) {
      const sameWorktreeHasUnknownIdentity = listed.value.some(
        (session) =>
          (session.worktreeId ?? inferWorktreeIdFromPtyId(session.id)) === worktreeId &&
          !session.terminalHandle
      )
      if (sameWorktreeHasUnknownIdentity) {
        // Why: older retained providers may list the first shell without its handle; absence is not authoritative in that shape.
        throw new Error('runtime_unavailable')
      }
      return null
    }
    const session = matches[0]
    const authoritativeWorktreeId = session.worktreeId ?? inferWorktreeIdFromPtyId(session.id)
    if (authoritativeWorktreeId !== worktreeId) {
      // Why: a reused address or forged provider record must never adopt a PTY from another workspace.
      throw new Error('terminal_create_identity_conflict')
    }
    this.host.adoptControllerTerminalHandle()(session.id, terminalHandle)
    const pty = this.host.recordPtyWorktree()(session.id, worktreeId, {
      connected: true,
      title: session.title,
      ...(session.incarnationId ? { incarnationId: session.incarnationId } : {}),
      ...(session.wslDistro !== undefined
        ? { wslDistro: session.wslDistro, isWsl: session.wslDistro !== null }
        : {})
    })
    const adoptedHandle = this.host.issuePtyHandle()(pty)
    if (adoptedHandle !== terminalHandle) {
      throw new Error('terminal_create_identity_conflict')
    }
    return {
      handle: adoptedHandle,
      ptyId: session.id,
      worktreeId,
      title: session.title || null,
      surface: 'background'
    }
  }

  getPtyExecutionHostMetadata(
    ptyId: string | null
  ): Pick<RuntimeTerminalCreate, 'executionHostId' | 'hostPlatform' | 'incarnationId'> {
    if (!ptyId) {
      return {}
    }
    const pty = this.host.getPtysById().get(ptyId)
    if (!pty) {
      return {}
    }
    if (pty.connectionId) {
      const remotePlatform = getRegisteredSshState(pty.connectionId)?.remotePlatform
      return {
        executionHostId: toSshExecutionHostId(pty.connectionId),
        ...(pty.incarnationId ? { incarnationId: pty.incarnationId } : {}),
        ...(remotePlatform ? { hostPlatform: remotePlatform } : {})
      }
    }
    return {
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      ...(pty.incarnationId ? { incarnationId: pty.incarnationId } : {}),
      hostPlatform: pty.isWsl || pty.wslDistro ? 'linux' : process.platform
    }
  }
}
