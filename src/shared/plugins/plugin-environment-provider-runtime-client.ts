import {
  pluginManagementRequestSchema,
  PLUGIN_MANAGEMENT_RUNTIME_CAPABILITY,
  type PluginManagementInput,
  type PluginManagementMethod,
  type PluginManagementResults
} from './plugin-management-api'
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
import { waitForPromiseWithSignal } from '../abort-signal-reason'
import {
  PLUGIN_ENVIRONMENT_PROVIDER_SSH_RUNTIME_CAPABILITY,
  PLUGIN_ENVIRONMENT_PROVIDER_RUNTIME_CAPABILITY
} from './plugin-environment-provider-runtime-capability'
import { pluginChangeEventSchema, type PluginChangeEvent } from './plugin-change-event'
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
  private capabilities: readonly string[] = []
  private admission?: Promise<void>
  private observation?: Promise<void>
  private observationId?: string
  private observationReady?: PromiseWithResolvers<void>
  private readonly listeners = new Set<(change: PluginChangeEvent) => void>()

  constructor(
    pairing: PairedRuntimeConnection,
    readonly runtimeId: string,
    private readonly onRetired: () => void = () => undefined,
    private readonly purpose: 'providers' | 'management' = 'providers'
  ) {
    z.string().min(1).max(256).parse(runtimeId)
    this.connection = new RemoteRuntimeRequestConnection(
      { ...pairing, credential: { ...pairing.credential } },
      [
        PLUGIN_ENVIRONMENT_PROVIDER_RUNTIME_CAPABILITY,
        PLUGIN_ENVIRONMENT_PROVIDER_SSH_RUNTIME_CAPABILITY,
        ...(purpose === 'management' ? [PLUGIN_MANAGEMENT_RUNTIME_CAPABILITY] : [])
      ],
      {
        kind: 'single-connection',
        onClosed: () => this.close(),
        onResponse: (response) => this.receive(response)
      }
    )
  }

  async call<Method extends EnvironmentProviderRuntimeMethod>(
    method: Method,
    input: EnvironmentProviderRuntimeInput<Method>,
    timeoutMs = method === 'prepareMigration'
      ? 16 * 660_000
      : method === 'execute' || method === 'recover' || method === 'connectSsh'
        ? 660_000
        : 15_000
  ): Promise<EnvironmentProviderRuntimeResults[Method]> {
    this.lifetime.signal.throwIfAborted()
    const params = environmentProviderRuntimeInputs[method].parse({
      ...input,
      runtimeId: this.runtimeId
    })
    try {
      await this.ready()
      if (method === 'connectSsh' && !this.supportsProviderSsh()) {
        throw new Error('Provider SSH connection is unavailable on this host')
      }
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

  async manage<Method extends PluginManagementMethod>(
    method: Method,
    input: PluginManagementInput<Method>
  ): Promise<PluginManagementResults[Method]> {
    this.lifetime.signal.throwIfAborted()
    if (this.purpose !== 'management') {
      throw new Error('This review does not manage plugins')
    }
    const params = pluginManagementRequestSchema.parse({ runtimeId: this.runtimeId, method, input })
    try {
      await this.ready()
      const response = await this.connection.request<PluginManagementResults[Method]>(
        'plugins.management.call',
        params,
        120_000,
        this.lifetime.signal
      )
      this.lifetime.signal.throwIfAborted()
      return this.result(response)
    } catch (error) {
      this.close()
      throw error
    }
  }

  async ready(): Promise<void> {
    this.lifetime.signal.throwIfAborted()
    try {
      this.admission ??= this.admit()
      await this.admission
      this.lifetime.signal.throwIfAborted()
    } catch (error) {
      this.close()
      throw error
    }
  }

  supportsProviderSsh(): boolean {
    return this.capabilities.includes(PLUGIN_ENVIRONMENT_PROVIDER_SSH_RUNTIME_CAPABILITY)
  }

  onChanged(listener: (change: PluginChangeEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async observe(): Promise<void> {
    await this.ready()
    this.observation ??= this.startObservation()
    try {
      await this.observation
      this.lifetime.signal.throwIfAborted()
    } catch (error) {
      this.close()
      throw error
    }
  }

  private async startObservation(): Promise<void> {
    this.observationReady = Promise.withResolvers<void>()
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(15_000)])
    const response = await this.connection.request(
      'runtime.clientEvents.subscribe',
      undefined,
      15_000,
      signal
    )
    this.result(response)
    if (this.observationId === undefined) {
      this.observationId = response.id
      this.receive(response)
    }
    await waitForPromiseWithSignal(this.observationReady.promise, signal)
  }

  private receive(response: RuntimeRpcResponse<unknown>): void {
    const type = response.ok ? z.object({ type: z.string() }).safeParse(response.result) : null
    if (this.observationReady && this.observationId === undefined && type?.success) {
      this.observationId = response.id
    }
    if (response.id !== this.observationId || this.lifetime.signal.aborted) {
      return
    }
    if (response._meta?.runtimeId !== this.runtimeId || !response.ok) {
      this.close()
      return
    }
    const event = z
      .object({ type: z.literal('pluginsChanged'), change: pluginChangeEventSchema })
      .safeParse(response.result)
    if (event.success) {
      for (const listener of this.listeners) {
        try {
          listener(event.data.change)
        } catch (error) {
          console.warn('[plugins] provider change listener failed:', error)
        }
      }
    } else if (
      z
        .object({ type: z.literal('ready'), subscriptionId: z.string().min(1) })
        .safeParse(response.result).success
    ) {
      this.observationReady?.resolve()
    } else if (type?.success && type.data.type === 'pluginsChanged') {
      this.close()
    } else if (z.object({ type: z.literal('end') }).safeParse(response.result).success) {
      this.close()
    }
  }

  close(): void {
    if (this.lifetime.signal.aborted) {
      return
    }
    this.lifetime.abort()
    this.connection.close()
    this.listeners.clear()
    this.onRetired()
  }

  private async admit(): Promise<void> {
    const status = statusSchema.parse(
      this.result(
        await this.connection.request('status.get', undefined, 15_000, this.lifetime.signal)
      )
    )
    this.capabilities = status.capabilities
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
    if (
      this.purpose === 'management' &&
      !status.capabilities.includes(PLUGIN_MANAGEMENT_RUNTIME_CAPABILITY)
    ) {
      throw new Error('Update Orca on this host to manage its plugin catalog')
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
