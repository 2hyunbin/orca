import { randomUUID, createHash } from 'node:crypto'
import type { PluginEnvironmentProviderReview } from '../../shared/plugins/plugin-environment-provider-api'
import type { EnvironmentRecipeResource } from '../../shared/environment-recipe-protocol'
import type { EnvironmentRecipeJournalOperation } from '../../shared/plugins/plugin-environment-recipe-journal'
import { executePluginEnvironmentRecipe } from './plugin-environment-recipe-execution'
import { environmentCommandInput } from './plugin-environment-command-execution'
import {
  prepareEnvironmentAdapterLaunch,
  type EnvironmentAdapterRuntime
} from './plugin-environment-adapter-launch'
import { environmentAdapterRuntime } from './plugin-environment-adapter-runtime'
import { verifyReviewedPluginRelease } from './plugin-reviewed-release'
import type { resolveReviewedPluginEnvironmentProvider } from './plugin-environment-provider-release'
import type { createPluginEnvironmentProviderControlContext } from './plugin-environment-provider-control-context'

export async function inspectPluginEnvironmentMigrationInventory(input: {
  review: PluginEnvironmentProviderReview
  authority: Awaited<ReturnType<typeof resolveReviewedPluginEnvironmentProvider>>
  control: Awaited<ReturnType<typeof createPluginEnvironmentProviderControlContext>>
  signal?: AbortSignal
  adapterRuntime?: EnvironmentAdapterRuntime
  userDataPath: string
}): Promise<{
  resources: EnvironmentRecipeResource[]
  operations: EnvironmentRecipeJournalOperation[]
}> {
  const resources = new Map<string, EnvironmentRecipeResource>()
  const operations: EnvironmentRecipeJournalOperation[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < 16; page += 1) {
    const request = {
      protocolVersion: 2 as const,
      providerId: input.review.providerId,
      contextId: input.review.contextId,
      operationId: randomUUID(),
      action: 'list' as const,
      ...(cursor ? { cursor } : {})
    }
    const startedAt = Date.now()
    const result = await executePluginEnvironmentRecipe({
      pluginKey: input.authority.registration.pluginKey,
      recipe: input.authority.registration.recipe,
      request,
      cwd: input.control.cwd,
      env: input.control.env,
      signal: input.signal,
      authorize: async (invocation) => {
        const signal = AbortSignal.any([input.authority.signal, input.control.signal])
        const launch = await prepareEnvironmentAdapterLaunch({
          authority: input.authority,
          invocation,
          signal: input.signal ? AbortSignal.any([signal, input.signal]) : signal,
          runtime: input.adapterRuntime ?? environmentAdapterRuntime(input.userDataPath)
        })
        await verifyReviewedPluginRelease(input.authority.plugin, input.review.reviewRevision)
        return {
          isCurrent: () => input.authority.isCurrent() && input.control.isCurrent(),
          signal,
          ...(launch ? { launch } : {})
        }
      }
    })
    if (result.kind !== 'completed' || result.response.kind !== 'inventory') {
      throw new Error('The provider did not confirm migration inventory')
    }
    for (const resource of result.response.resources) {
      if (resources.has(resource.id)) {
        throw new Error('Migration inventory repeats a machine across pages')
      }
      resources.set(resource.id, resource)
      if (resources.size > 1024) {
        throw new Error('Migration inventory exceeds the retained machine limit')
      }
    }
    operations.push({
      operationId: request.operationId,
      action: 'list',
      requestDigest: environmentCommandInput(request).requestDigest,
      startedAt,
      finishedAt: Math.max(Date.now(), startedAt),
      status: 'completed',
      resultDigest: createHash('sha256').update(JSON.stringify(result)).digest('hex')
    })
    cursor = result.response.nextCursor
    if (!cursor) {
      return { resources: [...resources.values()], operations }
    }
    if (seen.has(cursor)) {
      throw new Error('Migration inventory repeats a page')
    }
    seen.add(cursor)
  }
  throw new Error('Migration inventory exceeds its page limit')
}
