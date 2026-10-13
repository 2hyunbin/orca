import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { environmentRecipeRequestSchema } from '../../shared/environment-recipe-protocol'
import { pluginEnvironmentRecipeSchema } from '../../shared/plugins/plugin-environment-recipe-artifact'
import type { PluginEnvironmentProviderReview } from '../../shared/plugins/plugin-environment-provider-api'
import {
  createPluginEnvironmentProviderInstallFixture as fixture,
  disposePluginEnvironmentProviderInstallFixtures
} from './plugin-environment-provider-install-fixture'

afterEach(disposePluginEnvironmentProviderInstallFixtures)
function request(review: PluginEnvironmentProviderReview) {
  return environmentRecipeRequestSchema.parse({
    protocolVersion: 2,
    operationId: randomUUID(),
    providerId: review.providerId,
    contextId: review.contextId,
    action: 'list'
  })
}

describe('provider management uses durable host account configuration', () => {
  it('lists only currently approved providers and configures an account without executing the provider', async () => {
    const f = await fixture()
    expect(await f.service.environmentProviders.list()).toEqual([])
    await expect(f.service.environmentProviders.configure(f.review)).rejects.toThrow(
      'requires approval'
    )
    await f.approve()
    expect(await f.service.environmentProviders.list()).toMatchObject([
      {
        providerId: f.review.providerId,
        executionHostId: 'local',
        protocolVersion: 2,
        configuration: { status: 'unconfigured' }
      }
    ])
    await expect(
      f.service.environmentProviders.configure({ ...f.review, cwd: f.cwd })
    ).rejects.toThrow()
    await expect(
      f.service.environmentProviders.configure({ ...f.review, env: { SECRET: 'caller-env' } })
    ).rejects.toThrow()
    expect(await f.service.environmentProviders.configure(f.review)).toMatchObject([
      { configuration: { status: 'ready', contextId: f.review.contextId } }
    ])
    await expect(readFile(join(f.cwd, 'started'))).rejects.toThrow()
  })
  it('uses the host-selected launch context and preserves inventory through a service restart', async () => {
    const f = await fixture()
    await f.approve()
    await f.service.environmentProviders.configure(f.review)
    const result = await f.service.environmentProviders.execute(f.review, request(f.review))
    expect(result).toMatchObject({
      kind: 'executed',
      result: { kind: 'completed', response: { kind: 'inventory', resources: [{ id: 'devbox' }] } }
    })
    await f.service.dispose()
    const reopened = await f.reopen()
    expect(await reopened.environmentProviders.list()).toMatchObject([
      { configuration: { status: 'ready', contextId: f.review.contextId } }
    ])
    const snapshot = await reopened.environmentProviders.snapshot(f.review)
    expect(snapshot.resources).toMatchObject([{ id: 'devbox', lifetime: 'long-lived' }])
    expect(snapshot.operations).toHaveLength(1)
    await expect(
      reopened.environmentProviders.configure({ ...f.review, contextId: 'other-account' })
    ).rejects.toThrow()
    expect((await reopened.environmentProviders.snapshot(f.review)).resources).toHaveLength(1)
  })
  it('refuses reuse of account configuration after changed commands even before any inventory exists', async () => {
    const f = await fixture()
    await f.approve()
    await f.service.environmentProviders.configure(f.review)
    const path = join(f.sourceDir, 'recipe.json')
    const recipe = pluginEnvironmentRecipeSchema.parse(JSON.parse(await readFile(path, 'utf8')))
    recipe.commands.list.args.push('--new-command-version')
    await writeFile(path, JSON.stringify(recipe))
    await f.reinstall()
    await f.approve()
    const providers = await f.service.environmentProviders.list()
    expect(providers[0]?.configuration).toMatchObject({
      status: 'migration-required',
      contextId: f.review.contextId
    })
    const current = { ...providers[0]!.review, contextId: f.review.contextId }
    await expect(f.service.environmentProviders.execute(current, request(current))).rejects.toThrow(
      'migration'
    )
    await expect(readFile(join(f.cwd, 'started'))).rejects.toThrow()
  })
  it('denies further control operations after host service disposal', async () => {
    const f = await fixture()
    await f.approve()
    await f.service.environmentProviders.configure(f.review)
    await f.service.dispose()
    expect(await f.service.environmentProviders.list()).toEqual([])
    await expect(f.service.environmentProviders.configure(f.review)).rejects.toThrow('stopped')
    await expect(
      f.service.environmentProviders.execute(f.review, request(f.review))
    ).rejects.toThrow()
  })
})
