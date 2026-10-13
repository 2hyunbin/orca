import {
  pluginEnvironmentProviderMigrationPrepareSchema,
  pluginEnvironmentProviderMigrationCommitSchema
} from '../../shared/plugins/plugin-environment-provider-migration-api'
import { pluginEnvironmentProviderHistorySchema } from '../../shared/plugins/plugin-environment-provider-history-api'
import { pluginEnvironmentProviderSavedHistorySchema } from '../../shared/plugins/plugin-environment-provider-saved-history-api'
import { pluginEnvironmentProviderRecoverSchema } from '../../shared/plugins/plugin-environment-provider-recovery-api'
import { registerPluginRendererHandler } from './plugin-renderer-ipc'
import {
  pluginEnvironmentProviderCancelSchema,
  pluginEnvironmentProviderExecuteSchema,
  pluginEnvironmentProviderReviewSchema
} from '../../shared/plugins/plugin-environment-provider-api'
import { PluginEnvironmentProviderWindowOwners } from './plugin-environment-provider-window-owners'
import {
  pluginEnvironmentProviderSshPrepareSchema,
  pluginEnvironmentProviderSshSaveSchema,
  pluginEnvironmentProviderSshDiscardSchema
} from '../../shared/plugins/plugin-environment-provider-ssh-api'
import type { PluginEnvironmentProviderService } from '../plugins/plugin-environment-provider-service'
import { isTrustedBrowserRenderer } from './browser-renderer-trust'

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
type Owner = { controller: AbortController; senderId: number }
type ProviderOperations = Pick<
  PluginEnvironmentProviderService,
  'list' | 'configure' | 'snapshot' | 'execute'
> & {
  ssh?: Pick<
    PluginEnvironmentProviderService['ssh'],
    'prepare' | 'save' | 'revokeOwner' | 'discard'
  >
  recover?: PluginEnvironmentProviderService['recover']
  prepareMigration?: PluginEnvironmentProviderService['prepareMigration']
  commitMigration?: PluginEnvironmentProviderService['commitMigration']
  revokeMigrationOwner?: PluginEnvironmentProviderService['revokeMigrationOwner']
  previousSnapshot?: PluginEnvironmentProviderService['previousSnapshot']
  listSaved?: PluginEnvironmentProviderService['listSaved']
  savedSnapshot?: PluginEnvironmentProviderService['savedSnapshot']
}

export class PluginEnvironmentProviderIpcController {
  private readonly operations = new Map<string, Owner>()
  private readonly windows = new PluginEnvironmentProviderWindowOwners((key) => {
    this.service.ssh?.revokeOwner(key)
    this.service.revokeMigrationOwner?.(key)
  })
  constructor(
    private readonly service: ProviderOperations,
    private readonly isTrusted: (
      sender: PluginEnvironmentProviderSender
    ) => boolean = isTrustedBrowserRenderer
  ) {}

  private requireTrusted(sender: PluginEnvironmentProviderSender): void {
    if (!this.isTrusted(sender)) {
      throw new Error('Environment providers are only available to the trusted app window')
    }
  }
  list(sender: PluginEnvironmentProviderSender) {
    this.requireTrusted(sender)
    return this.service.list()
  }
  listSaved(sender: PluginEnvironmentProviderSender) {
    this.requireTrusted(sender)
    if (!this.service.listSaved) {
      throw new Error('Saved provider history is unavailable')
    }
    return this.service.listSaved()
  }
  savedSnapshot(sender: PluginEnvironmentProviderSender, input: unknown) {
    this.requireTrusted(sender)
    if (!this.service.savedSnapshot) {
      throw new Error('Saved provider history is unavailable')
    }
    return this.service.savedSnapshot(pluginEnvironmentProviderSavedHistorySchema.parse(input))
  }
  configure(sender: PluginEnvironmentProviderSender, input: unknown) {
    this.requireTrusted(sender)
    return this.service.configure(pluginEnvironmentProviderReviewSchema.parse(input))
  }
  snapshot(sender: PluginEnvironmentProviderSender, input: unknown) {
    this.requireTrusted(sender)
    return this.service.snapshot(pluginEnvironmentProviderReviewSchema.parse(input))
  }
  async execute(sender: PluginEnvironmentProviderSender, input: unknown) {
    this.requireTrusted(sender)
    const { review, request } = pluginEnvironmentProviderExecuteSchema.parse(input)
    return this.runOwned(sender, request.operationId, (signal) =>
      this.service.execute(review, request, signal)
    )
  }
  prepareMigration(sender: PluginEnvironmentProviderSender, input: unknown) {
    this.requireTrusted(sender)
    const request = pluginEnvironmentProviderMigrationPrepareSchema.parse(input)
    const prepare = this.service.prepareMigration?.bind(this.service)
    if (!prepare) {
      throw new Error('Provider migration is unavailable')
    }
    const ownerKey = this.windows.ownerKey(sender)
    return this.runOwned(sender, request.queryId, (signal) => prepare(ownerKey, request, signal))
  }
  commitMigration(sender: PluginEnvironmentProviderSender, input: unknown) {
    this.requireTrusted(sender)
    const request = pluginEnvironmentProviderMigrationCommitSchema.parse(input)
    const commit = this.service.commitMigration?.bind(this.service)
    if (!commit) {
      throw new Error('Provider migration is unavailable')
    }
    return commit(this.windows.ownerKey(sender), request)
  }
  previousSnapshot(sender: PluginEnvironmentProviderSender, input: unknown) {
    this.requireTrusted(sender)
    const request = pluginEnvironmentProviderHistorySchema.parse(input)
    if (!this.service.previousSnapshot) {
      throw new Error('Provider history is unavailable')
    }
    return this.service.previousSnapshot(request)
  }
  recover(sender: PluginEnvironmentProviderSender, input: unknown) {
    this.requireTrusted(sender)
    const request = pluginEnvironmentProviderRecoverSchema.parse(input)
    const recover = this.service.recover?.bind(this.service)
    if (!recover) {
      throw new Error('Provider receipt inspection is unavailable')
    }
    return this.runOwned(sender, request.queryId, (signal) => recover(request, signal))
  }
  prepareSsh(sender: PluginEnvironmentProviderSender, input: unknown) {
    this.requireTrusted(sender)
    const { operationId, review, resourceId, expectedRevision } =
      pluginEnvironmentProviderSshPrepareSchema.parse(input)
    const ssh = this.service.ssh
    if (!ssh) {
      throw new Error('Provider SSH management is unavailable')
    }
    const ownerKey = this.windows.ownerKey(sender)
    return this.runOwned(sender, operationId, async (signal) => {
      const preview = await ssh.prepare(ownerKey, review, resourceId, expectedRevision, signal)
      if (signal.aborted) {
        ssh.revokeOwner(ownerKey)
        throw new Error('The SSH connection review was cancelled')
      }
      return preview
    })
  }
  saveSsh(sender: PluginEnvironmentProviderSender, input: unknown) {
    this.requireTrusted(sender)
    const { ticketId, identityFile, approveEndpointUpdate } =
      pluginEnvironmentProviderSshSaveSchema.parse(input)
    const ssh = this.service.ssh
    if (!ssh) {
      throw new Error('Provider SSH management is unavailable')
    }
    return ssh.save(this.windows.ownerKey(sender), ticketId, identityFile, approveEndpointUpdate)
  }
  discardSsh(sender: PluginEnvironmentProviderSender, input: unknown): boolean {
    this.requireTrusted(sender)
    const { ticketId } = pluginEnvironmentProviderSshDiscardSchema.parse(input)
    return this.service.ssh?.discard(this.windows.ownerKey(sender), ticketId) ?? false
  }
  private async runOwned<T>(
    sender: PluginEnvironmentProviderSender,
    operationId: string,
    run: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    if (this.operations.has(operationId)) {
      throw new Error('This environment operation is already in progress')
    }
    if (this.operations.size >= 8) {
      throw new Error('Too many environment operations are running on this host')
    }
    const owner = { controller: new AbortController(), senderId: sender.id }
    this.operations.set(operationId, owner)
    const onGone = (): void => {
      owner.controller.abort()
    }
    const onNavigate = (details: NavigationDetails): void => {
      if (details.isMainFrame && !details.isSameDocument) {
        owner.controller.abort()
      }
    }
    sender.once('destroyed', onGone)
    sender.once('render-process-gone', onGone)
    sender.on('did-start-navigation', onNavigate)
    try {
      return await run(owner.controller.signal)
    } finally {
      sender.removeListener('destroyed', onGone)
      sender.removeListener('render-process-gone', onGone)
      sender.removeListener('did-start-navigation', onNavigate)
      if (this.operations.get(operationId) === owner) {
        this.operations.delete(operationId)
      }
    }
  }
  cancel(sender: PluginEnvironmentProviderSender, input: unknown): boolean {
    this.requireTrusted(sender)
    const { operationId } = pluginEnvironmentProviderCancelSchema.parse(input)
    const owner = this.operations.get(operationId)
    if (!owner || owner.senderId !== sender.id) {
      return false
    }
    owner.controller.abort()
    return true
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
