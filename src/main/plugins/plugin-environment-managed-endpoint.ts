import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { lstat, mkdir, rm } from 'node:fs/promises'
import { z } from 'zod'
import type { SshTarget } from '../../shared/ssh-types'
import { getManagedOrcadFenceEnvironmentId } from '../../shared/managed-orcad-ssh-owner'
import { listEnvironments } from '../../shared/runtime-environment-store'
import {
  OrcadDeploymentLinkSchema,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import { runtimeEnvironmentSshAccessBinding } from '../../shared/runtime-environment-authority-binding'
import { rebindManagedOrcadSshGeneration } from '../../shared/runtime-environment-managed-orcad-store'
import { assertRuntimeEnvironmentNotReconciling } from '../../shared/runtime-environment-reconciliation-record'
import { writeSecureFile } from '../../shared/secure-file'
import { withFileTransactionLock } from '../file-transaction-lock'
import { readContainedPluginArtifactText } from './plugin-artifact-file-reader'
import type { SshConnectionStore } from '../ssh/ssh-connection-store'
import { getSshTargetRegistryStore } from '../ssh/ssh-target-registry'
import { prepareEnvironmentProviderTarget } from '../ssh/ssh-environment-provider-registration'
import type { PluginEnvironmentSshBinding } from '../../shared/plugins/plugin-environment-ssh-binding'
import type { EnvironmentRecipeJournalBinding } from '../../shared/plugins/plugin-environment-recipe-journal'
import { environmentProviderSshFields } from './plugin-environment-provider-ssh-registration'

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u)
const IntentSchema = z.strictObject({
  version: z.literal(1),
  targetId: z.string().min(1).max(256),
  environmentId: z.string().min(1).max(256),
  previousDeployment: OrcadDeploymentLinkSchema,
  nextGeneration: z.number().int().positive(),
  previousTargetDigest: DigestSchema,
  nextTargetDigest: DigestSchema,
  environmentDigest: DigestSchema
})
type Intent = z.infer<typeof IntentSchema>
const digest = (value: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(value) ?? 'undefined')
    .digest('hex')

export async function recoverProviderManagedEndpoint(
  userDataPath: string,
  targetId: string
): Promise<void> {
  const store = getSshTargetRegistryStore()
  if (store) {
    await new PluginEnvironmentManagedEndpoint(userDataPath).recover(store, targetId)
  }
}

export class PluginEnvironmentManagedEndpoint {
  private readonly directory: string
  constructor(private readonly userDataPath: string) {
    this.directory = join(userDataPath, 'plugin-environment-endpoints')
  }
  private filename(targetId: string): string {
    return `${digest(targetId)}.json`
  }
  private async lock<T>(targetId: string, apply: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const info = await lstat(this.directory)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('Endpoint transitions require a regular private directory')
    }
    return withFileTransactionLock(join(this.directory, this.filename(targetId)), apply)
  }
  private environment(target: SshTarget): KnownRuntimeEnvironment | undefined {
    const environmentId = getManagedOrcadFenceEnvironmentId(target)
    if (!environmentId) {
      if (target.orcadProvisioning) {
        throw new Error('The saved SSH host is still provisioning its managed server')
      }
      return undefined
    }
    const environment = listEnvironments(this.userDataPath).find(
      (entry) => entry.id === environmentId
    )
    if (
      !environment?.orcadDeployment ||
      environment.orcadDeployment.sshTargetId !== target.id ||
      environment.orcadDeployment.sshTargetGeneration !== target.generation
    ) {
      throw new Error('The managed SSH deployment is unfinished or its registration changed')
    }
    assertRuntimeEnvironmentNotReconciling(environment)
    return environment
  }
  async recover(store: SshConnectionStore, targetId: string): Promise<void> {
    if (!(await this.read(targetId))) {
      return
    }
    await this.lock(targetId, () => this.recoverLocked(store, targetId))
  }
  private async read(targetId: string): Promise<Intent | undefined> {
    try {
      const info = await lstat(this.directory)
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error('Endpoint transitions require a regular private directory')
      }
      const raw = await readContainedPluginArtifactText(
        this.directory,
        this.filename(targetId),
        8192
      )
      const intent = IntentSchema.parse(JSON.parse(raw))
      if (
        intent.targetId !== targetId ||
        intent.nextGeneration <= intent.previousDeployment.sshTargetGeneration ||
        intent.previousDeployment.sshTargetId !== targetId
      ) {
        throw new Error('The saved endpoint transition names another registration')
      }
      return intent
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return undefined
      }
      throw error
    }
  }
  private async recoverLocked(store: SshConnectionStore, targetId: string): Promise<void> {
    const intent = await this.read(targetId)
    if (!intent) {
      return
    }
    const target = store.getTarget(targetId)
    const environment = listEnvironments(this.userDataPath).find(
      (entry) => entry.id === intent.environmentId
    )
    if (
      !target ||
      !environment?.orcadDeployment ||
      getManagedOrcadFenceEnvironmentId(target) !== intent.environmentId ||
      digest(runtimeEnvironmentSshAccessBinding(environment)) !== intent.environmentDigest
    ) {
      throw new Error('The interrupted endpoint transition changed owner or server authority')
    }
    const nextDeployment = {
      ...intent.previousDeployment,
      sshTargetGeneration: intent.nextGeneration
    }
    if (
      digest(target) === intent.previousTargetDigest &&
      digest(environment.orcadDeployment) === digest(intent.previousDeployment)
    ) {
      await rm(join(this.directory, this.filename(targetId)))
      return
    }
    if (digest(target) !== intent.nextTargetDigest || target.generation !== intent.nextGeneration) {
      throw new Error('The interrupted endpoint transition changed its SSH registration')
    }
    if (digest(environment.orcadDeployment) === digest(intent.previousDeployment)) {
      await store.getOrcadMigrationSource().flushPendingOrThrowAsync()
      rebindManagedOrcadSshGeneration(this.userDataPath, environment, intent.nextGeneration)
    } else if (digest(environment.orcadDeployment) !== digest(nextDeployment)) {
      throw new Error('The interrupted endpoint transition changed its managed deployment')
    }
    await rm(join(this.directory, this.filename(targetId)))
  }
  async commit(input: {
    store: SshConnectionStore
    previous: SshTarget
    owner: PluginEnvironmentSshBinding
    label: string
    identityFile?: string
    migratedFrom?: EnvironmentRecipeJournalBinding
    retire(): Promise<void>
    isCurrent(): boolean
  }): Promise<SshTarget> {
    const path = join(this.directory, this.filename(input.previous.id))
    return this.lock(input.previous.id, async () => {
      await this.recoverLocked(input.store, input.previous.id)
      const environment = this.environment(input.previous)
      const deployment = environment?.orcadDeployment
      if (!environment || !deployment) {
        throw new Error('This endpoint transition has no registered managed server')
      }
      await input.retire()
      if (!input.isCurrent()) {
        throw new Error('Environment connection review changed')
      }
      const next = prepareEnvironmentProviderTarget(
        input.store.getOrcadMigrationSource(),
        input.owner,
        environmentProviderSshFields(input.owner, input.label, input.identityFile),
        input.migratedFrom,
        input.previous,
        { environmentId: environment.id, generation: deployment.sshTargetGeneration }
      )
      const intent = IntentSchema.parse({
        version: 1,
        targetId: next.id,
        environmentId: environment.id,
        previousDeployment: environment.orcadDeployment,
        nextGeneration: next.generation,
        previousTargetDigest: digest(input.previous),
        nextTargetDigest: digest(next),
        environmentDigest: digest(runtimeEnvironmentSshAccessBinding(environment))
      })
      if (!writeSecureFile(path, JSON.stringify(intent), { durable: true })) {
        throw new Error('Endpoint transition permissions could not be restricted')
      }
      if (
        !input.isCurrent() ||
        digest(input.store.getTarget(next.id)) !== intent.previousTargetDigest
      ) {
        throw new Error('The saved SSH connection changed before endpoint publication')
      }
      const published = input.store.getOrcadMigrationSource().updateSshTarget(next.id, next)
      if (!published) {
        throw new Error('The saved SSH connection disappeared during endpoint publication')
      }
      await input.store.getOrcadMigrationSource().flushPendingOrThrowAsync()
      await this.recoverLocked(input.store, next.id)
      return published
    })
  }
  isManaged(target: SshTarget): boolean {
    return this.environment(target) !== undefined
  }
}
