import { registerPluginRendererHandler } from './plugin-renderer-ipc'
import { PluginEnvironmentProviderWindowOwners } from './plugin-environment-provider-window-owners'
import type { PluginEnvironmentProviderService } from '../plugins/plugin-environment-provider-service'
import {
  environmentProviderControllerForService,
  type PluginEnvironmentProviderOperations
} from '../plugins/plugin-environment-provider-controller'
import type { PluginEnvironmentProviderRequestOwner } from '../plugins/plugin-environment-provider-operation-owners'
import { isTrustedBrowserRenderer } from './browser-renderer-trust'
import { pluginEnvironmentProviderExecuteSchema } from '../../shared/plugins/plugin-environment-provider-api'
import { pluginEnvironmentProviderRecoverSchema } from '../../shared/plugins/plugin-environment-provider-recovery-api'
import {
  pluginEnvironmentProviderMigrationPrepareSchema,
  pluginEnvironmentProviderMigrationCommitSchema
} from '../../shared/plugins/plugin-environment-provider-migration-api'
import {
  pluginEnvironmentProviderSshPrepareSchema,
  pluginEnvironmentProviderSshSaveSchema,
  pluginEnvironmentProviderSshDiscardSchema,
  type EnvironmentProviderSshPreview
} from '../../shared/plugins/plugin-environment-provider-ssh-api'
type NavigationDetails = Pick<
  Electron.WebContentsDidStartNavigationEventParams,
  'isMainFrame' | 'isSameDocument'
>
export type PluginEnvironmentProviderSender = Pick<
  Electron.WebContents,
  'id' | 'getType' | 'getURL' | 'isDestroyed'
> & {
  once(event: 'destroyed' | 'render-process-gone', listener: () => void): void
  on(event: 'did-start-navigation', listener: (details: NavigationDetails) => void): void
  removeListener(
    event: string,
    listener: (() => void) | ((details: NavigationDetails) => void)
  ): void
}
export class PluginEnvironmentProviderIpcController {
  private readonly controller
  private readonly windows = new PluginEnvironmentProviderWindowOwners((key) =>
    this.controller.revokeOwner(key)
  )
  constructor(
    service: PluginEnvironmentProviderOperations,
    private readonly isTrusted: (
      sender: PluginEnvironmentProviderSender
    ) => boolean = isTrustedBrowserRenderer
  ) {
    this.controller = environmentProviderControllerForService(service)
  }

  private requireTrusted(sender: PluginEnvironmentProviderSender): void {
    if (!this.isTrusted(sender)) {
      throw new Error('Environment providers are only available to the trusted app window')
    }
  }
  list(sender: PluginEnvironmentProviderSender) {
    this.requireTrusted(sender)
    return this.controller.list()
  }
  listSaved(sender: PluginEnvironmentProviderSender) {
    this.requireTrusted(sender)
    return this.controller.listSaved()
  }
  savedSnapshot(sender: PluginEnvironmentProviderSender, input: unknown) {
    this.requireTrusted(sender)
    return this.controller.savedSnapshot(input)
  }
  configure(sender: PluginEnvironmentProviderSender, input: unknown) {
    this.requireTrusted(sender)
    return this.controller.configure(input)
  }
  snapshot(sender: PluginEnvironmentProviderSender, input: unknown) {
    this.requireTrusted(sender)
    return this.controller.snapshot(input)
  }
  previousSnapshot(sender: PluginEnvironmentProviderSender, input: unknown) {
    this.requireTrusted(sender)
    return this.controller.previousSnapshot(input)
  }
  async execute(sender: PluginEnvironmentProviderSender, input: unknown) {
    this.requireTrusted(sender)
    const request = pluginEnvironmentProviderExecuteSchema.parse(input)
    return this.runOwned(sender, (owner) => this.controller.execute(owner, request))
  }
  recover(sender: PluginEnvironmentProviderSender, input: unknown) {
    this.requireTrusted(sender)
    const request = pluginEnvironmentProviderRecoverSchema.parse(input)
    return this.runOwned(sender, (owner) => this.controller.recover(owner, request))
  }
  prepareMigration(sender: PluginEnvironmentProviderSender, input: unknown) {
    this.requireTrusted(sender)
    const request = pluginEnvironmentProviderMigrationPrepareSchema.parse(input)
    return this.runOwned(sender, (owner) => this.controller.prepareMigration(owner, request), true)
  }
  prepareSsh(
    sender: PluginEnvironmentProviderSender,
    input: unknown
  ): Promise<EnvironmentProviderSshPreview> {
    this.requireTrusted(sender)
    const request = pluginEnvironmentProviderSshPrepareSchema.parse(input)
    return this.runOwned(sender, (owner) => this.controller.prepareSsh(owner, request), true)
  }
  commitMigration(sender: PluginEnvironmentProviderSender, input: unknown) {
    this.requireTrusted(sender)
    const request = pluginEnvironmentProviderMigrationCommitSchema.parse(input)
    return this.controller.commitMigration(
      { key: this.windows.ownerKey(sender), signal: new AbortController().signal },
      request
    )
  }
  saveSsh(sender: PluginEnvironmentProviderSender, input: unknown) {
    this.requireTrusted(sender)
    const request = pluginEnvironmentProviderSshSaveSchema.parse(input)
    return this.controller.saveSsh(
      { key: this.windows.ownerKey(sender), signal: new AbortController().signal },
      request
    )
  }
  discardSsh(sender: PluginEnvironmentProviderSender, input: unknown) {
    this.requireTrusted(sender)
    const request = pluginEnvironmentProviderSshDiscardSchema.parse(input)
    return this.controller.discardSsh(
      { key: this.windows.ownerKey(sender), signal: new AbortController().signal },
      request
    )
  }
  cancel(sender: PluginEnvironmentProviderSender, input: unknown): boolean {
    this.requireTrusted(sender)
    return this.controller.cancel(`window:${sender.id}`, input)
  }
  private async runOwned<T>(
    sender: PluginEnvironmentProviderSender,
    run: (owner: PluginEnvironmentProviderRequestOwner) => Promise<T>,
    review = false
  ): Promise<T> {
    if (sender.isDestroyed()) {
      throw new Error('The app window is no longer available')
    }
    const controller = new AbortController()
    const onGone = (): void => controller.abort()
    const onNavigate = (details: NavigationDetails): void => {
      if (details.isMainFrame && !details.isSameDocument) {
        controller.abort()
      }
    }
    sender.once('destroyed', onGone)
    sender.once('render-process-gone', onGone)
    sender.on('did-start-navigation', onNavigate)
    try {
      return await run({
        key: `window:${sender.id}`,
        signal: controller.signal,
        ...(review ? { reviewKey: this.windows.ownerKey(sender) } : {})
      })
    } finally {
      sender.removeListener('destroyed', onGone)
      sender.removeListener('render-process-gone', onGone)
      sender.removeListener('did-start-navigation', onNavigate)
    }
  }
}

export function registerPluginEnvironmentProviderHandlers(
  service: PluginEnvironmentProviderService
): void {
  const controller = new PluginEnvironmentProviderIpcController(service)
  registerPluginRendererHandler('plugins:listSavedEnvironmentProviders', (event) =>
    controller.listSaved(event.sender)
  )
  registerPluginRendererHandler(
    'plugins:savedEnvironmentProviderSnapshot',
    (event, input: unknown) => controller.savedSnapshot(event.sender, input)
  )
  registerPluginRendererHandler(
    'plugins:prepareEnvironmentProviderMigration',
    (event, input: unknown) => controller.prepareMigration(event.sender, input)
  )
  registerPluginRendererHandler(
    'plugins:commitEnvironmentProviderMigration',
    (event, input: unknown) => controller.commitMigration(event.sender, input)
  )
  registerPluginRendererHandler(
    'plugins:previousEnvironmentProviderSnapshot',
    (event, input: unknown) => controller.previousSnapshot(event.sender, input)
  )
  registerPluginRendererHandler('plugins:recoverEnvironmentProvider', (event, input: unknown) =>
    controller.recover(event.sender, input)
  )
  registerPluginRendererHandler('plugins:prepareEnvironmentProviderSsh', (event, input: unknown) =>
    controller.prepareSsh(event.sender, input)
  )
  registerPluginRendererHandler('plugins:saveEnvironmentProviderSsh', (event, input: unknown) =>
    controller.saveSsh(event.sender, input)
  )
  registerPluginRendererHandler(
    'plugins:discardEnvironmentProviderSshReview',
    (event, input: unknown) => controller.discardSsh(event.sender, input)
  )
  registerPluginRendererHandler('plugins:listEnvironmentProviders', (event) =>
    controller.list(event.sender)
  )
  registerPluginRendererHandler('plugins:configureEnvironmentProvider', (event, input: unknown) =>
    controller.configure(event.sender, input)
  )
  registerPluginRendererHandler('plugins:environmentProviderSnapshot', (event, input: unknown) =>
    controller.snapshot(event.sender, input)
  )
  registerPluginRendererHandler('plugins:executeEnvironmentProvider', (event, input: unknown) =>
    controller.execute(event.sender, input)
  )
  registerPluginRendererHandler('plugins:cancelEnvironmentProvider', (event, input: unknown) =>
    controller.cancel(event.sender, input)
  )
}
