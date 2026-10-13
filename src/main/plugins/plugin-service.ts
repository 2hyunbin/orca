import type { PluginEventName } from '../../shared/plugins/plugin-manifest'
import {
  capabilityKinds,
  type PluginCapabilityKind
} from '../../shared/plugins/plugin-capabilities'
import type { getPluginActivationState } from '../../shared/plugins/plugin-consent-state'
import type { PluginPanelActionOutcome } from '../../shared/plugins/plugin-panel-bridge'
import { createPluginExtensionRegistry } from '../../shared/plugins/plugin-extension-registry'
import {
  getPluginsDataDir,
  getUserPluginsDir,
  type DiscoveredPlugin,
  type ValidDiscoveredPlugin
} from './plugin-discovery'
import { PluginEventBus } from './plugin-event-bus'
import { PluginAuditLog } from './plugin-audit-log'
import { executePluginHostCallRequest } from './plugin-host-call-adapter'
import { PluginContentVerifier } from './plugin-content-integrity'
import { bindPluginHostServices, type PluginRuntimeDelegate } from './plugin-host-service-bindings'
import { PluginPanelController } from './plugin-panel-controller'
import { PluginWorkerController } from './plugin-worker-controller'
import { PluginServiceHousekeeping } from './plugin-service-housekeeping'
import type { PluginRunState } from './plugin-supervisor'
import {
  pluginServiceActivationState,
  pluginServiceActivationError,
  snapshotPluginConsentLists
} from './plugin-activation-policy'
import { PluginContentPackRegistry } from './plugin-content-pack-registry'
import type { PluginServiceOptions } from './plugin-service-options'
import type { PluginChangeEvent } from '../../shared/plugins/plugin-change-event'
import { waitForPluginRefreshSettlement } from './plugin-refresh-settlement'
import { assertPluginWorkerCommand } from './plugin-command-invocation'
import { deliverPluginEvent } from './plugin-event-delivery'
import { PluginInstallationState } from './plugin-installation-state'
import { PluginServiceChangeEvents } from './plugin-service-change-events'
import { PluginEnvironmentProviderService } from './plugin-environment-provider-service'
import { PluginBundledDataRegistry } from './plugin-bundled-data-registry'
import {
  refreshPluginServiceContent,
  reconcilePluginServiceContent,
  type PluginServiceContentLifecycleHost
} from './plugin-service-content-lifecycle'

export type { PluginRuntimeDelegate } from './plugin-host-service-bindings'
export type { PluginLogLine } from './plugin-log-buffer'
export type { PluginServiceOptions } from './plugin-service-options'

export class PluginService {
  private readonly registry = createPluginExtensionRegistry()
  private readonly eventBus = new PluginEventBus()
  private readonly audit: PluginAuditLog
  private readonly workerController: PluginWorkerController
  private readonly contentVerifier = new PluginContentVerifier()
  readonly environmentProviders: PluginEnvironmentProviderService
  readonly contentPacks: PluginContentPackRegistry
  readonly panels: PluginPanelController
  private readonly changeEvents = new PluginServiceChangeEvents()
  private readonly housekeeping = new PluginServiceHousekeeping()
  private runtimeDelegate: PluginRuntimeDelegate | null = null
  private initPromise: Promise<void> | null = null
  private refreshChain: Promise<void> = Promise.resolve()
  private contentPacksReady = false
  private disposed = false
  private readonly bundledData: PluginBundledDataRegistry
  private readonly installed = new PluginInstallationState({
    pluginsDir: () => getUserPluginsDir(this.options.userDataPath),
    deactivate: (pluginKey) => this.workerController.deactivate(pluginKey),
    notifyChanged: () => this.notifyChanged(false)
  })

  constructor(readonly options: PluginServiceOptions) {
    this.bundledData = new PluginBundledDataRegistry(
      options.bundledPluginsRoot
        ? {
            root: options.bundledPluginsRoot,
            hostVersion: options.hostVersion
          }
        : undefined
    )
    this.contentPacks = new PluginContentPackRegistry(
      this.contentVerifier,
      (pluginKey) => Boolean(this.options.getPluginKillListEntry?.(pluginKey)),
      (plugin) => !this.disposed && this.isRuntimeApproved(plugin),
      {
        locale: (plugin, locale) => this.bundledData.localeAlias(plugin, locale),
        syntax: (plugin, language) => this.bundledData.syntaxAlias(plugin, language)
      },
      (plugin) =>
        !this.disposed &&
        this.isRuntimeApproved(plugin, false) &&
        JSON.stringify(this.findValidPlugin(plugin.pluginKey)) === JSON.stringify(plugin)
    )
    this.environmentProviders = PluginEnvironmentProviderService.forService(
      this,
      options,
      this.changeEvents.providerChanged
    )
    this.audit = new PluginAuditLog(getPluginsDataDir(options.userDataPath))
    this.panels = new PluginPanelController({
      resolveApprovedPlugin: (pluginKey) => {
        const plugin = this.findValidPlugin(pluginKey)
        return plugin && this.isRuntimeApproved(plugin) ? plugin : null
      },
      contentVerifier: this.contentVerifier,
      executeHostCall: (pluginKey, method, params) =>
        this.executeHostCall(pluginKey, method, params, { viaPanel: true }),
      log: (pluginKey) => this.installed.captureLog(pluginKey, 'error')
    })
    this.workerController = new PluginWorkerController({
      entryPath: options.hostEntryPath ?? '',
      maxActive: options.maxActiveWorkers,
      idleReapMs: options.idleReapMs,
      workerFactory: options.workerFactory,
      registry: this.registry,
      contentVerifier: this.contentVerifier,
      capabilities: (pluginKey) => this.getGrantedCapabilities(pluginKey),
      isCurrentApproved: (plugin) =>
        this.findValidPlugin(plugin.pluginKey) === plugin && this.isRuntimeApproved(plugin),
      invokeCommand: (pluginKey, commandId, args) => this.invokeCommand(pluginKey, commandId, args),
      executeHostCall: (pluginKey, method, params) =>
        this.executeHostCall(pluginKey, method, params, { viaPanel: false }),
      log: (pluginKey) => this.installed.logs.capture(pluginKey),
      onStateChanged: () => this.notifyChanged(false),
      onWorkerGone: (pluginKey) => this.eventBus.clear(pluginKey)
    })
  }

  setRuntimeDelegate(delegate: PluginRuntimeDelegate | null): void {
    this.runtimeDelegate = delegate
  }

  readonly onChanged = (listener: (event: PluginChangeEvent) => void): (() => void) =>
    this.changeEvents.subscribe(listener)

  private notifyChanged = (contentPacksChanged: boolean): void =>
    this.changeEvents.notify({ contentPacksChanged })

  async initialize(): Promise<void> {
    this.initPromise ??= this.refresh()
    return this.initPromise
  }

  async whenReady(): Promise<void> {
    await (this.initPromise ?? Promise.resolve()).catch(() => undefined)
    // Client reads wait for the complete transaction so rollback-based content
    // validation cannot expose a partially activated plugin between passes.
    await waitForPluginRefreshSettlement(() => this.refreshChain)
  }

  refresh(): Promise<void> {
    // Snapshot settings at request time so a quick off→on sequence still
    // processes the off transition and revokes old workers/panel sessions.
    const enabled = this.options.isPluginSystemEnabled()
    if (enabled) {
      this.contentPacks.environmentRecipes.invalidateUnavailable()
    } else {
      this.contentPacks.environmentRecipes.invalidate()
    }
    const devPaths = this.options.getDevPluginPaths()
    const consentLists = snapshotPluginConsentLists(this.options)
    const refresh = this.refreshChain.then(() =>
      refreshPluginServiceContent(this.contentLifecycleHost(), enabled, devPaths, consentLists)
    )
    this.refreshChain = refresh.catch(() => undefined)
    return refresh
  }

  private contentLifecycleHost(): PluginServiceContentLifecycleHost {
    return {
      options: this.options,
      contentPacks: this.contentPacks,
      contentVerifier: this.contentVerifier,
      bundledData: this.bundledData,
      installed: this.installed,
      workerController: this.workerController,
      panels: this.panels,
      housekeeping: this.housekeeping,
      isDisposed: () => this.disposed,
      setReady: (ready) => {
        this.contentPacksReady = ready
      },
      isRuntimeApproved: (plugin) => this.isRuntimeApproved(plugin),
      activationState: (plugin) => this.activationState(plugin),
      notifyChanged: (changed) => this.notifyChanged(changed),
      scheduleRefresh: () => {
        void this.refresh()
      }
    }
  }

  getDiscovered(): readonly DiscoveredPlugin[] {
    return this.installed.discovered
  }

  getLogs(pluginKey: string) {
    return this.installed.logs.get(pluginKey)
  }

  findValidPlugin(pluginKey: string): ValidDiscoveredPlugin | null {
    return this.installed.findValid(pluginKey)
  }

  activationState(plugin: ValidDiscoveredPlugin): ReturnType<typeof getPluginActivationState> {
    return pluginServiceActivationState(plugin, this.options, (candidate) =>
      this.bundledData.owns(candidate)
    )
  }

  isBundledDataPlugin(plugin: DiscoveredPlugin): boolean {
    return this.bundledData.contains(plugin)
  }

  getBundledDataAliases() {
    return this.bundledData.aliases()
  }

  listBundledData() {
    return this.bundledData.states(this.options.getDisabledBundledDataPlugins?.() ?? [], (key) =>
      Boolean(this.options.getPluginKillListEntry?.(key) || this.contentPacks.error(key))
    )
  }

  private isRuntimeApproved(plugin: ValidDiscoveredPlugin, requireReady = true): boolean {
    return (
      !this.installed.isRemoving(plugin) &&
      (!requireReady || this.contentPacksReady) &&
      this.activationState(plugin) === 'approved' &&
      !this.contentPacks.error(plugin.pluginKey) &&
      !this.options.getPluginKillListEntry?.(plugin.pluginKey)
    )
  }

  workerState(pluginKey: string): { state: PluginRunState; restarts: number } {
    return this.workerController.state(pluginKey)
  }

  activationError(pluginKey: string): string | null {
    return pluginServiceActivationError(
      this.options.getPluginKillListEntry?.(pluginKey),
      () => this.contentPacks.error(pluginKey),
      () => this.workerController.activationError(pluginKey)
    )
  }

  /** Consented capability kinds for an approved plugin; null otherwise so
   *  callers deny uniformly (no probe-able distinction). */
  getGrantedCapabilities(pluginKey: string): PluginCapabilityKind[] | null {
    const plugin = this.findValidPlugin(pluginKey)
    return plugin && this.isRuntimeApproved(plugin)
      ? capabilityKinds(plugin.manifest.capabilities)
      : null
  }

  /** Host API chokepoint for both transports (worker fork IPC + panel
   *  bridge); serve RPC reuses it through the same entry points. */
  async executeHostCall(
    pluginKey: string,
    method: string,
    params: unknown,
    options: { viaPanel: boolean }
  ): Promise<PluginPanelActionOutcome> {
    return executePluginHostCallRequest({
      pluginKey,
      request: { method, params },
      viaPanel: options.viaPanel,
      resolvePolicy: (boundPluginKey) => ({
        grantedCapabilities: this.getGrantedCapabilities(boundPluginKey),
        services: this.runtimeDelegate
          ? bindPluginHostServices({
              delegate: this.runtimeDelegate,
              pluginsDataDir: getPluginsDataDir(this.options.userDataPath),
              subscribeEvents: (key, events) => this.eventBus.subscribe(key, events)
            })
          : null,
        audit: this.audit
      })
    })
  }

  async invokeCommand(pluginKey: string, commandId: string, args?: unknown): Promise<unknown> {
    const plugin = this.findValidPlugin(pluginKey)
    if (!plugin || !this.isRuntimeApproved(plugin)) {
      throw new Error(`plugin ${pluginKey} is not enabled`)
    }
    assertPluginWorkerCommand(plugin, commandId)
    const handle = await this.workerController.ensure(plugin)
    if (!handle.commands.includes(commandId)) {
      throw new Error(`plugin ${pluginKey} registered no handler for ${commandId}`)
    }
    return handle.invokeCommand(commandId, args)
  }

  emitEvent(event: PluginEventName, payload: unknown): void {
    if (!this.options.isPluginSystemEnabled() || this.disposed) {
      return
    }
    deliverPluginEvent({
      event,
      payload,
      plugins: this.installed.discovered,
      eventBus: this.eventBus,
      workerController: this.workerController,
      isRuntimeApproved: (plugin) => this.isRuntimeApproved(plugin),
      logWarning: (pluginKey) => this.installed.captureLog(pluginKey, 'warn')
    })
  }

  removePlugin(pluginKey: string, remove: () => Promise<void>): Promise<void> {
    const plugin = this.findValidPlugin(pluginKey)
    if (plugin && this.bundledData.owns(plugin)) {
      return Promise.reject(new Error('app-owned language data cannot be removed'))
    }
    this.contentPacks.environmentRecipes.invalidate(pluginKey)
    const removal = this.refreshChain.then(() => this.installed.remove(pluginKey, remove))
    this.refreshChain = removal.catch(() => undefined)
    return removal
  }

  async deactivatePlugin(pluginKey: string): Promise<void> {
    await this.workerController.deactivate(pluginKey)
    this.notifyChanged(false)
  }

  /** Reconciles live workers and client projections after consent or
   * enablement changes without re-reading plugin files or starting workers. */
  async reconcileActivationState(): Promise<void> {
    this.contentPacks.environmentRecipes.invalidateUnavailable()
    const reconcile = this.refreshChain.then(() =>
      reconcilePluginServiceContent(this.contentLifecycleHost())
    )
    this.refreshChain = reconcile.catch(() => undefined)
    return reconcile
  }

  async dispose(): Promise<void> {
    this.environmentProviders.dispose()
    this.contentPacks.environmentRecipes.invalidate()
    this.disposed = true
    this.housekeeping.dispose()
    this.panels.dispose()
    await this.refreshChain.catch(() => undefined)
    await this.workerController.dispose()
    await this.audit.flush()
  }
}
