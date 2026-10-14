import {
  pluginEnvironmentProviderMigrationPrepareSchema,
  pluginEnvironmentProviderMigrationCommitSchema
} from '../../shared/plugins/plugin-environment-provider-migration-api'
import { pluginEnvironmentProviderHistorySchema } from '../../shared/plugins/plugin-environment-provider-history-api'
import { pluginEnvironmentProviderSavedHistorySchema } from '../../shared/plugins/plugin-environment-provider-saved-history-api'
import { pluginEnvironmentProviderRecoverSchema } from '../../shared/plugins/plugin-environment-provider-recovery-api'
import {
  pluginEnvironmentProviderCancelSchema,
  pluginEnvironmentProviderExecuteSchema,
  pluginEnvironmentProviderReviewSchema
} from '../../shared/plugins/plugin-environment-provider-api'
import {
  pluginEnvironmentProviderSshConnectSchema,
  pluginEnvironmentProviderSshPrepareSchema,
  pluginEnvironmentProviderSshSaveSchema,
  pluginEnvironmentProviderSshDiscardSchema
} from '../../shared/plugins/plugin-environment-provider-ssh-api'
import type { PluginEnvironmentProviderService } from './plugin-environment-provider-service'

import {
  PluginEnvironmentProviderOperationOwners,
  type PluginEnvironmentProviderRequestOwner
} from './plugin-environment-provider-operation-owners'
export type PluginEnvironmentProviderOperations = Pick<
  PluginEnvironmentProviderService,
  'list' | 'configure' | 'snapshot' | 'execute'
> & {
  ssh?: Pick<
    PluginEnvironmentProviderService['ssh'],
    'prepare' | 'save' | 'revokeOwner' | 'discard'
  > & { connectSavedTarget?: PluginEnvironmentProviderService['ssh']['connectSavedTarget'] }
  recover?: PluginEnvironmentProviderService['recover']
  prepareMigration?: PluginEnvironmentProviderService['prepareMigration']
  commitMigration?: PluginEnvironmentProviderService['commitMigration']
  revokeMigrationOwner?: PluginEnvironmentProviderService['revokeMigrationOwner']
  previousSnapshot?: PluginEnvironmentProviderService['previousSnapshot']
  listSaved?: PluginEnvironmentProviderService['listSaved']
  savedSnapshot?: PluginEnvironmentProviderService['savedSnapshot']
}

export class PluginEnvironmentProviderController {
  private readonly operations = new PluginEnvironmentProviderOperationOwners()
  private readonly boundSignals = new WeakMap<AbortSignal, string>()
  constructor(private readonly service: PluginEnvironmentProviderOperations) {}

  bindOwnerSignal(key: string, signal: AbortSignal): void {
    signal.throwIfAborted()
    const current = this.boundSignals.get(signal)
    if (current !== undefined) {
      if (current !== key) {
        throw new Error('Environment provider connection owner changed')
      }
      return
    }
    this.boundSignals.set(signal, key)
    signal.addEventListener('abort', () => this.revokeOwner(key), { once: true })
  }

  revokeOwner(key: string): void {
    this.operations.revoke(key)
    this.service.ssh?.revokeOwner(key)
    this.service.revokeMigrationOwner?.(key)
  }
  list() {
    return this.service.list()
  }
  listSaved() {
    if (!this.service.listSaved) {
      throw new Error('Saved provider history is unavailable')
    }
    return this.service.listSaved()
  }
  savedSnapshot(input: unknown) {
    if (!this.service.savedSnapshot) {
      throw new Error('Saved provider history is unavailable')
    }
    return this.service.savedSnapshot(pluginEnvironmentProviderSavedHistorySchema.parse(input))
  }
  configure(input: unknown) {
    return this.service.configure(pluginEnvironmentProviderReviewSchema.parse(input))
  }
  snapshot(input: unknown) {
    return this.service.snapshot(pluginEnvironmentProviderReviewSchema.parse(input))
  }
  async execute(owner: PluginEnvironmentProviderRequestOwner, input: unknown) {
    const { review, request } = pluginEnvironmentProviderExecuteSchema.parse(input)
    return this.operations.run(owner, request.operationId, (signal) =>
      this.service.execute(review, request, signal)
    )
  }
  prepareMigration(owner: PluginEnvironmentProviderRequestOwner, input: unknown) {
    const request = pluginEnvironmentProviderMigrationPrepareSchema.parse(input)
    const prepare = this.service.prepareMigration?.bind(this.service)
    if (!prepare) {
      throw new Error('Provider migration is unavailable')
    }
    const ownerKey = owner.reviewKey ?? owner.key
    return this.operations.run(owner, request.queryId, (signal) =>
      prepare(ownerKey, request, signal)
    )
  }
  commitMigration(owner: PluginEnvironmentProviderRequestOwner, input: unknown) {
    const request = pluginEnvironmentProviderMigrationCommitSchema.parse(input)
    const commit = this.service.commitMigration?.bind(this.service)
    if (!commit) {
      throw new Error('Provider migration is unavailable')
    }
    return commit(owner.reviewKey ?? owner.key, request)
  }
  previousSnapshot(input: unknown) {
    const request = pluginEnvironmentProviderHistorySchema.parse(input)
    if (!this.service.previousSnapshot) {
      throw new Error('Provider history is unavailable')
    }
    return this.service.previousSnapshot(request)
  }
  recover(owner: PluginEnvironmentProviderRequestOwner, input: unknown) {
    const request = pluginEnvironmentProviderRecoverSchema.parse(input)
    const recover = this.service.recover?.bind(this.service)
    if (!recover) {
      throw new Error('Provider receipt inspection is unavailable')
    }
    return this.operations.run(owner, request.queryId, (signal) => recover(request, signal))
  }
  prepareSsh(owner: PluginEnvironmentProviderRequestOwner, input: unknown) {
    const { operationId, review, resourceId, expectedRevision } =
      pluginEnvironmentProviderSshPrepareSchema.parse(input)
    const ssh = this.service.ssh
    if (!ssh) {
      throw new Error('Provider SSH management is unavailable')
    }
    const ownerKey = owner.reviewKey ?? owner.key
    return this.operations.run(owner, operationId, async (signal) => {
      const preview = await ssh.prepare(ownerKey, review, resourceId, expectedRevision, signal)
      if (signal.aborted) {
        ssh.revokeOwner(ownerKey)
        throw new Error('The SSH connection review was cancelled')
      }
      return preview
    })
  }
  async saveSsh(owner: PluginEnvironmentProviderRequestOwner, input: unknown) {
    const { ticketId, identityFile, approveEndpointUpdate } =
      pluginEnvironmentProviderSshSaveSchema.parse(input)
    const ssh = this.service.ssh
    if (!ssh) {
      throw new Error('Provider SSH management is unavailable')
    }
    const target = await ssh.save(
      owner.reviewKey ?? owner.key,
      ticketId,
      identityFile,
      approveEndpointUpdate
    )
    owner.signal.throwIfAborted()
    return target
  }
  connectSsh(owner: PluginEnvironmentProviderRequestOwner, input: unknown) {
    const request = pluginEnvironmentProviderSshConnectSchema.parse(input)
    const ssh = this.service.ssh
    const connect = ssh?.connectSavedTarget?.bind(ssh)
    if (!connect) {
      throw new Error('Provider SSH management is unavailable')
    }
    return this.operations.run(owner, request.operationId, (signal) =>
      connect(owner.reviewKey ?? owner.key, request.targetId, request.expectedGeneration, signal)
    )
  }

  discardSsh(owner: PluginEnvironmentProviderRequestOwner, input: unknown): boolean {
    const { ticketId } = pluginEnvironmentProviderSshDiscardSchema.parse(input)
    return this.service.ssh?.discard(owner.reviewKey ?? owner.key, ticketId) ?? false
  }
  cancel(key: string, input: unknown): boolean {
    const { operationId } = pluginEnvironmentProviderCancelSchema.parse(input)
    return this.operations.cancel(key, operationId)
  }
}

const controllers = new WeakMap<
  PluginEnvironmentProviderOperations,
  PluginEnvironmentProviderController
>()
export function environmentProviderControllerForService(
  service: PluginEnvironmentProviderOperations
): PluginEnvironmentProviderController {
  let controller = controllers.get(service)
  if (!controller) {
    controller = new PluginEnvironmentProviderController(service)
    controllers.set(service, controller)
  }
  return controller
}
