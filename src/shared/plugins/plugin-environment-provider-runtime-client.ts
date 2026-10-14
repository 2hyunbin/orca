import { z } from 'zod'
import type { PairedRuntimeConnection } from '../paired-runtime-connection'
import { RemoteRuntimeRequestConnection } from '../remote-runtime-request-connection'
import { evaluateRuntimeCompat, describeRuntimeCompatBlock } from '../protocol-compat'
import {
  RUNTIME_PROTOCOL_VERSION,
  MIN_COMPATIBLE_RUNTIME_SERVER_VERSION
} from '../protocol-version'
import type { RuntimeRpcResponse } from '../runtime-rpc-envelope'
import { unwrapRuntimeRpcResult } from '../runtime-rpc-result'
import { PLUGIN_ENVIRONMENT_PROVIDER_RUNTIME_CAPABILITY } from './plugin-environment-provider-runtime-capability'
import {
  environmentProviderRuntimeInputs,
  type EnvironmentProviderRuntimeInput,
  type EnvironmentProviderRuntimeMethod,
  type EnvironmentProviderRuntimeResults
} from './plugin-environment-provider-runtime-calls'

const statusSchema = z.object({
  runtimeId: z.string().min(1).max(256),
  capabilities: z.array(z.string()),
  runtimeProtocolVersion: z.number().optional(),
  protocolVersion: z.number().optional(),
  minCompatibleRuntimeClientVersion: z.number().optional(),
  minCompatibleMobileVersion: z.number().optional()
})

/** Review tickets and commands stay on one authenticated socket and server instance. */
export class PluginEnvironmentProviderRuntimeClient {
  private readonly connection: RemoteRuntimeRequestConnection
  private readonly lifetime = new AbortController()
  private admission?: Promise<void>

  constructor(
    pairing: PairedRuntimeConnection,
    readonly runtimeId: string,
    private readonly onRetired: () => void = () => undefined
  ) {
    z.string().min(1).max(256).parse(runtimeId)
    this.connection = new RemoteRuntimeRequestConnection(
      { ...pairing, credential: { ...pairing.credential } },
      [PLUGIN_ENVIRONMENT_PROVIDER_RUNTIME_CAPABILITY],
      { kind: 'single-connection', onClosed: () => this.close() }
    )
  }

  async call<Method extends EnvironmentProviderRuntimeMethod>(
    method: Method,
    input: EnvironmentProviderRuntimeInput<Method>,
    timeoutMs = method === 'prepareMigration'
      ? 16 * 660_000
      : method === 'execute' || method === 'recover'
        ? 660_000
        : 15_000
  ): Promise<EnvironmentProviderRuntimeResults[Method]> {
    this.lifetime.signal.throwIfAborted()
    const params = environmentProviderRuntimeInputs[method].parse({
      ...input,
      runtimeId: this.runtimeId
    })
    try {
      this.admission ??= this.admit()
      await this.admission
      this.lifetime.signal.throwIfAborted()
      const response = await this.connection.request<EnvironmentProviderRuntimeResults[Method]>(
        `plugins.environments.${method}`,
        params,
        timeoutMs,
        this.lifetime.signal
      )
      this.lifetime.signal.throwIfAborted()
      return this.result(response)
    } catch (error) {
      this.close()
      throw error
    }
  }

  close(): void {
    if (this.lifetime.signal.aborted) {
      return
    }
    this.lifetime.abort()
    this.connection.close()
    this.onRetired()
  }

  private async admit(): Promise<void> {
    const status = statusSchema.parse(
      this.result(
        await this.connection.request('status.get', undefined, 15_000, this.lifetime.signal)
      )
    )
    if (status.runtimeId !== this.runtimeId) {
      throw new Error('Environment provider review belongs to another server instance')
    }
    const compatibility = evaluateRuntimeCompat({
      clientProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleServerProtocolVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
      serverProtocolVersion: status.runtimeProtocolVersion ?? status.protocolVersion,
      serverMinCompatibleClientProtocolVersion:
        status.minCompatibleRuntimeClientVersion ?? status.minCompatibleMobileVersion
    })
    if (compatibility.kind === 'blocked') {
      throw new Error(describeRuntimeCompatBlock(compatibility))
    }
    if (!status.capabilities.includes(PLUGIN_ENVIRONMENT_PROVIDER_RUNTIME_CAPABILITY)) {
      throw new Error('This host does not support environment providers')
    }
  }

  private result<Result>(response: RuntimeRpcResponse<Result>): Result {
    if (response._meta?.runtimeId !== this.runtimeId) {
      throw new Error('Environment provider response belongs to another server instance')
    }
    return unwrapRuntimeRpcResult(response)
  }
}
