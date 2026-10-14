import { createHash } from 'node:crypto'
import { devicePrincipalOf } from './device-principal'
import type { DeviceEntry } from './device-entry'
import type { RpcBinarySender } from './rpc/rpc-binary-sender'
import { managedWorkspaceStatusReply } from './managed-workspace-gateway-frames'
import { sendRemoteRuntimeRequest } from '../../shared/remote-runtime-client'
import {
  MANAGED_RUNTIME_SESSION_CAPABILITY,
  MANAGED_RUNTIME_SESSION_LIFETIME_MS,
  ManagedRuntimeSessionGrantSchema,
  type ManagedRuntimeSessionGrant
} from '../../shared/managed-runtime-session-contract'
import {
  openRemoteRuntimePassthroughSocket,
  type RemoteRuntimePassthroughCallbacks,
  type RemoteRuntimePassthroughSocket
} from '../../shared/remote-runtime-passthrough-socket'
import type { RuntimeCapability } from '../../shared/protocol-version'
import type { RuntimeDeviceGrant } from './rpc/rpc-method-permission'
import type {
  ManagedWorkspaceGatewayLink,
  ManagedWorkspaceHost,
  ManagedWorkspaceStatus
} from './managed-workspace-gateway-contract'

const TIMEOUT_MS = 5000
const RENEW_INTERVAL_MS = 10_000

export class ManagedWorkspaceChildSession {
  private grant: ManagedRuntimeSessionGrant | null = null
  private socket: RemoteRuntimePassthroughSocket | null = null
  private renewal: ReturnType<typeof setInterval> | null = null
  private closed = false
  private renewing = false
  private renewalDeadline = 0
  private opening: Promise<RemoteRuntimePassthroughSocket> | null = null
  private retirement: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly options: {
      host: ManagedWorkspaceHost
      subjectKey: string
      grants: readonly RuntimeDeviceGrant[]
      capabilities: readonly RuntimeCapability[]
      isCurrent(): boolean
      callbacks: RemoteRuntimePassthroughCallbacks
      fail(): void
    }
  ) {}

  open(): Promise<RemoteRuntimePassthroughSocket> {
    this.opening = this.openSession()
    return this.opening
  }

  private async openSession(): Promise<RemoteRuntimePassthroughSocket> {
    const { host } = this.options
    const status = await sendRemoteRuntimeRequest<ManagedWorkspaceStatus>(
      host.connection,
      'status.get',
      {},
      TIMEOUT_MS
    )
    if (
      !status.ok ||
      status._meta?.runtimeId !== host.runtimeId ||
      !Array.isArray(status.result.capabilities) ||
      !status.result.capabilities.includes(MANAGED_RUNTIME_SESSION_CAPABILITY)
    ) {
      throw new Error('Managed server needs an update or its identity changed')
    }
    this.assertCurrent()
    const opened = await sendRemoteRuntimeRequest<ManagedRuntimeSessionGrant>(
      host.connection,
      'pairing.managedRuntimeSession.open',
      {
        subjectKey: this.options.subjectKey,
        name: 'Workspace through controller',
        grants: this.options.grants
      },
      TIMEOUT_MS
    )
    if (!opened.ok) {
      throw new Error('Managed server refused the workspace session')
    }
    this.grant = ManagedRuntimeSessionGrantSchema.parse(opened.result)
    this.renewalDeadline = Date.now() + MANAGED_RUNTIME_SESSION_LIFETIME_MS
    try {
      if (opened._meta?.runtimeId !== host.runtimeId) {
        throw new Error('Managed server identity changed while opening the session')
      }
      this.assertCurrent()
      const socket = await openRemoteRuntimePassthroughSocket(
        {
          ...host.connection,
          credential: { kind: 'token', deviceToken: this.grant.token },
          pairedDeviceId: this.grant.deviceId
        },
        this.options.capabilities,
        this.options.callbacks,
        { timeoutMs: TIMEOUT_MS }
      )
      this.socket = socket
      this.assertCurrent()
      this.renewal = setInterval(() => void this.renew(), RENEW_INTERVAL_MS)
      this.renewal.unref?.()
      return socket
    } catch (error) {
      this.close()
      throw error
    }
  }

  get clientId(): string {
    if (!this.grant) {
      throw new Error('Managed session is not ready')
    }
    return this.grant.deviceId
  }

  close(): void {
    if (this.closed && !this.grant && !this.socket) {
      return
    }
    this.closed = true
    if (this.renewal) {
      clearInterval(this.renewal)
    }
    this.renewal = null
    this.socket?.close()
    this.socket = null
    const grant = this.grant
    this.grant = null
    if (grant) {
      this.retirement = sendRemoteRuntimeRequest(
        this.options.host.connection,
        'pairing.managedRuntimeSession.revoke',
        { deviceId: grant.deviceId },
        TIMEOUT_MS
      ).catch(() => {})
    }
  }

  async drain(): Promise<void> {
    await this.opening?.catch(() => {})
    await this.retirement
  }

  private assertCurrent(): void {
    if (this.closed || !this.options.isCurrent() || !this.options.host.isCurrent()) {
      throw new Error('Managed workspace authority changed')
    }
  }

  private async renew(): Promise<void> {
    if (this.renewing || this.closed) {
      return
    }
    this.renewing = true
    try {
      this.assertCurrent()
      if (!this.grant || this.renewalDeadline <= Date.now()) {
        throw new Error('Managed session expired')
      }
      const result = await sendRemoteRuntimeRequest<{ expiresAt: number }>(
        this.options.host.connection,
        'pairing.managedRuntimeSession.renew',
        { deviceId: this.grant.deviceId },
        TIMEOUT_MS
      )
      this.assertCurrent()
      if (
        !result.ok ||
        result._meta?.runtimeId !== this.options.host.runtimeId ||
        !Number.isFinite(result.result.expiresAt)
      ) {
        throw new Error('Managed session renewal failed')
      }
      this.grant.expiresAt = result.result.expiresAt
      this.renewalDeadline = Date.now() + MANAGED_RUNTIME_SESSION_LIFETIME_MS
    } catch {
      this.close()
      this.options.fail()
    } finally {
      this.renewing = false
    }
  }
}

export function createManagedWorkspaceGatewaySession(options: {
  host: ManagedWorkspaceHost
  link: ManagedWorkspaceGatewayLink
  device: DeviceEntry
  isCurrent(): boolean
  end(): void
  reply(frame: string): void
  binary: RpcBinarySender
}): ManagedWorkspaceChildSession {
  const { host, link, device, isCurrent, end, reply, binary } = options
  const session = new ManagedWorkspaceChildSession({
    host,
    subjectKey: createHash('sha256')
      .update(devicePrincipalOf(device).callerFingerprint)
      .digest('hex'),
    grants: [],
    capabilities: link.socket.clientCapabilities,
    isCurrent,
    fail: end,
    callbacks: {
      onText: (frame) => {
        if (!isCurrent()) {
          end()
          return
        }
        const scoped = managedWorkspaceStatusReply(
          frame,
          link.statusIds,
          link.socket.device.deviceId
        )
        reply(scoped)
      },
      onBinary: (bytes) => {
        if (!isCurrent() || binary(bytes) === false) {
          end()
        }
      },
      onClose: end
    }
  })
  return session
}
