import { executePluginEnvironmentRecovery } from './plugin-environment-recovery-execution'
import {
  pluginEnvironmentProviderRecoverSchema,
  type PluginEnvironmentProviderRecoverRequest,
  type PluginEnvironmentProviderRecoveryResult
} from '../../shared/plugins/plugin-environment-provider-recovery-api'
import {
  environmentRecipeRequestSchema,
  type EnvironmentRecipeRequest
} from '../../shared/environment-recipe-protocol'
import { environmentRecipeDigest } from './plugin-environment-recipe-execution'
import { PluginEnvironmentRecipeJournalStore } from './plugin-environment-recipe-journal-store'
import {
  executeJournaledPluginEnvironmentRecipe,
  type JournaledEnvironmentRecipeResult
} from './plugin-environment-recipe-operation'
import { resolveReviewedPluginEnvironmentProvider } from './plugin-environment-provider-release'
import type { PluginService } from './plugin-service'
import { verifyReviewedPluginRelease } from './plugin-reviewed-release'
import type { EnvironmentRecipeJournalBinding } from '../../shared/plugins/plugin-environment-recipe-journal'
import { buildPluginEnvironmentRecipeBinding } from './plugin-environment-recipe-binding'
import {
  pluginEnvironmentProviderReviewSchema,
  type PluginEnvironmentProviderReview
} from '../../shared/plugins/plugin-environment-provider-api'

export type PluginEnvironmentRecipeReview = PluginEnvironmentProviderReview
export type PluginEnvironmentRecipeControlContext = {
  binding: EnvironmentRecipeJournalBinding
  contextId: string
  cwd: string
  env: NodeJS.ProcessEnv
  signal: AbortSignal
  isCurrent(): boolean
}

/** Runs only on the provider's own host; clients cannot supply its cwd, environment or journal owner. */
export class PluginEnvironmentRecipeHost {
  constructor(
    private readonly options: {
      service: Pick<PluginService, 'whenReady' | 'contentPacks'>
      userDataPath: string
      controlContext(providerId: string): Promise<PluginEnvironmentRecipeControlContext | null>
    }
  ) {}

  async snapshot(review: PluginEnvironmentRecipeReview) {
    const admission = await this.admit(review)
    return new PluginEnvironmentRecipeJournalStore(
      this.options.userDataPath,
      admission.binding
    ).snapshot()
  }

  async execute(
    inputReview: PluginEnvironmentRecipeReview,
    input: EnvironmentRecipeRequest,
    signal?: AbortSignal
  ): Promise<JournaledEnvironmentRecipeResult> {
    const review = pluginEnvironmentProviderReviewSchema.parse(structuredClone(inputReview))
    const request = environmentRecipeRequestSchema.parse(structuredClone(input))
    if (
      request.protocolVersion !== 2 ||
      request.providerId !== review.providerId ||
      request.contextId !== review.contextId
    ) {
      throw new Error('Environment request does not match its reviewed provider context')
    }
    const admission = await this.admit(structuredClone(review))
    return executeJournaledPluginEnvironmentRecipe({
      userDataPath: this.options.userDataPath,
      executionHostId: 'local',
      sourceDigest: admission.binding.sourceDigest,
      ...(admission.binding.journalId ? { journalId: admission.binding.journalId } : {}),
      pluginKey: admission.authority.registration.pluginKey,
      recipe: admission.authority.registration.recipe,
      request,
      cwd: admission.control.cwd,
      env: admission.control.env,
      signal,
      authorize: this.grant(review, admission)
    })
  }

  async recover(
    input: PluginEnvironmentProviderRecoverRequest,
    signal?: AbortSignal
  ): Promise<PluginEnvironmentProviderRecoveryResult> {
    const { review, queryId, originalOperationId } = pluginEnvironmentProviderRecoverSchema.parse(
      structuredClone(input)
    )
    const admission = await this.admit(review)
    const journal = new PluginEnvironmentRecipeJournalStore(
      this.options.userDataPath,
      admission.binding
    )
    const prepared = await journal.recoveryRequest(originalOperationId, queryId)
    if (!prepared.request) {
      return { kind: 'known', operation: prepared.operation }
    }
    const result = await executePluginEnvironmentRecovery({
      pluginKey: admission.authority.registration.pluginKey,
      recipe: admission.authority.registration.recipe,
      request: prepared.request,
      cwd: admission.control.cwd,
      env: admission.control.env,
      signal,
      authorize: this.grant(review, admission)
    })
    const operation =
      result.kind === 'completed' && result.response.kind === 'receipt'
        ? await journal.recordRecoveryReceipt(prepared.request, result.response, {
            isCurrent: () => admission.isCurrent() && !signal?.aborted
          })
        : prepared.operation
    return { kind: 'inspected', operation, result }
  }

  private grant(
    review: PluginEnvironmentRecipeReview,
    admission: {
      isCurrent(): boolean
      authority: { signal: AbortSignal }
      control: { signal: AbortSignal }
    }
  ) {
    return async (invocation: { recipeDigest: string; providerId: string }) => {
      if (
        invocation.recipeDigest !== review.recipeDigest ||
        invocation.providerId !== review.providerId ||
        !admission.isCurrent()
      ) {
        return null
      }
      const current = await this.options.service.contentPacks.environmentRecipes.resolveAuthority(
        review.providerId
      )
      if (
        !current ||
        current.plugin.reviewRevision !== review.reviewRevision ||
        current.plugin.consentFingerprint !== review.consentFingerprint ||
        environmentRecipeDigest(current.registration.recipe) !== review.recipeDigest
      ) {
        return null
      }
      await verifyReviewedPluginRelease(current.plugin, review.reviewRevision)
      return {
        isCurrent: () => admission.isCurrent() && current.isCurrent(),
        signal: AbortSignal.any([
          admission.authority.signal,
          current.signal,
          admission.control.signal
        ])
      }
    }
  }

  private async admit(input: PluginEnvironmentRecipeReview) {
    const review = pluginEnvironmentProviderReviewSchema.parse(structuredClone(input))
    const authority = await resolveReviewedPluginEnvironmentProvider(this.options.service, review)
    const { plugin, registration } = authority
    const control = await this.options.controlContext(review.providerId)
    if (!control || control.contextId !== review.contextId) {
      throw new Error('Environment provider has no current host-selected account context')
    }
    const binding = buildPluginEnvironmentRecipeBinding(
      plugin,
      registration.recipe,
      review.contextId,
      control.binding.journalId
    )
    if (JSON.stringify(control.binding) !== JSON.stringify(binding)) {
      throw new Error(
        'Changed provider source, commands or account context requires inventory migration'
      )
    }
    const context = { ...control, env: { ...control.env } }
    const isCurrent = () =>
      authority.isCurrent() &&
      JSON.stringify(control.binding) === JSON.stringify(binding) &&
      !context.signal.aborted &&
      context.isCurrent() &&
      control.contextId === context.contextId &&
      control.cwd === context.cwd
    if (!isCurrent()) {
      throw new Error('Environment provider or control host changed during admission')
    }
    return {
      authority,
      control: context,
      isCurrent,
      binding
    }
  }
}
