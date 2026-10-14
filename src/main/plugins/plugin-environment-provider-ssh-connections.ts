import { fingerprintSshTargetConnection } from '../ssh/ssh-target-connection-fingerprint'
import type { SshTarget } from '../../shared/ssh-types'
import { pluginEnvironmentSshBindingSchema } from '../../shared/plugins/plugin-environment-ssh-binding'
import {
  connectRegisteredSshTarget,
  getRegisteredSshState,
  getSshTargetRegistryStore
} from '../ssh/ssh-target-registry'
import { getPublicSshState, getPublicSshError } from '../runtime/public-ssh-state'
import type { EnvironmentProviderSshLease } from '../ssh/environment-provider-ssh-admission'

type SavedConnection = { generation: number; binding: string; fingerprint: string }
export class PluginEnvironmentProviderSshConnections {
  private readonly saved = new Map<string, Map<string, SavedConnection>>()
  remember(ownerKey: string, target: SshTarget): void {
    if (!target.generation || !target.environmentProvider) {
      return
    }
    const targets = this.saved.get(ownerKey) ?? new Map<string, SavedConnection>()
    if (targets.size >= 32 && !targets.has(target.id)) {
      throw new Error('Too many saved SSH connections in this review')
    }
    targets.set(target.id, {
      generation: target.generation,
      fingerprint: fingerprintSshTargetConnection(target),
      binding: JSON.stringify(pluginEnvironmentSshBindingSchema.parse(target.environmentProvider))
    })
    this.saved.set(ownerKey, targets)
  }
  clear(): void {
    this.saved.clear()
  }
  revokeOwner(ownerKey: string): void {
    this.saved.delete(ownerKey)
  }
  async connect(
    ownerKey: string,
    targetId: string,
    generation: number,
    signal: AbortSignal,
    authorize: (target: SshTarget) => Promise<EnvironmentProviderSshLease>
  ) {
    signal.throwIfAborted()
    const saved = this.saved.get(ownerKey)?.get(targetId)
    const current = (): SshTarget => {
      signal.throwIfAborted()
      const target = getSshTargetRegistryStore()?.getTarget(targetId)
      if (
        !saved ||
        !target ||
        target.generation !== generation ||
        saved.generation !== generation ||
        fingerprintSshTargetConnection(target) !== saved.fingerprint ||
        JSON.stringify(target.environmentProvider) !== saved.binding ||
        this.saved.get(ownerKey)?.get(targetId) !== saved
      ) {
        throw new Error('The saved SSH connection changed or belongs to another review')
      }
      return target
    }
    const lease = await authorize(current())
    const stillApproved = (): void => {
      current()
      if (lease.signal.aborted || !lease.isCurrent()) {
        throw new Error('Environment provider SSH approval changed')
      }
    }
    stillApproved()
    try {
      const state = await connectRegisteredSshTarget(targetId)
      stillApproved()
      if (state.targetId !== targetId) {
        throw new Error('SSH connection belongs to another target')
      }
      return getPublicSshState(state)
    } catch {
      stillApproved()
      throw new Error(getPublicSshError(getRegisteredSshState(targetId)?.status ?? 'error'))
    }
  }
}
