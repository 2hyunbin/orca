import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { environmentRecipeRequestSchema } from '../../shared/environment-recipe-protocol'
import type { PluginEnvironmentRecipeReview } from './plugin-environment-recipe-host'
import {
  createPluginEnvironmentProviderInstallFixture as fixture,
  disposePluginEnvironmentProviderInstallFixtures
} from './plugin-environment-provider-install-fixture'

afterEach(disposePluginEnvironmentProviderInstallFixtures)
function request(
  review: PluginEnvironmentRecipeReview,
  action: string,
  revision?: string,
  resourceId = 'devbox'
) {
  return environmentRecipeRequestSchema.parse({
    protocolVersion: 2,
    operationId: randomUUID(),
    providerId: review.providerId,
    contextId: review.contextId,
    action,
    ...(action === 'create'
      ? { parameters: {} }
      : action === 'list'
        ? {}
        : { resourceId, expectedRevision: revision })
  })
}

describe('approved provider host uses the existing plugin service', () => {
  it('cannot admit a pending provider or a caller-selected account context', async () => {
    const f = await fixture()
    await expect(f.host.snapshot(f.review)).rejects.toThrow('requires approval')
    await f.approve()
    await expect(f.host.snapshot({ ...f.review, contextId: 'another-account' })).rejects.toThrow(
      'host-selected'
    )
    await expect(readFile(join(f.cwd, 'started'))).rejects.toThrow()
  })
  it('executes all six actions and retains a long-lived machine beside an ephemeral sandbox', async () => {
    const f = await fixture()
    await f.approve()
    for (const action of ['list', 'create', 'sleep', 'resume', 'archive', 'delete']) {
      const before = await f.host.snapshot(f.review)
      const sandbox = before.resources.find((row) => row.id === 'sandbox')
      const result = await f.host.execute(
        f.review,
        request(f.review, action, sandbox?.revision, 'sandbox')
      )
      expect(result, JSON.stringify({ action, result })).toMatchObject({
        kind: 'executed',
        result: { kind: 'completed' }
      })
    }
    const final = await f.host.snapshot(f.review)
    expect(final.resources).toMatchObject([
      { id: 'devbox', lifetime: 'long-lived', state: 'running' },
      { id: 'sandbox', lifetime: 'ephemeral', state: 'deleted' }
    ])
    expect(final.operations).toHaveLength(6)
    const repeated = request(f.review, 'list')
    await f.host.execute(f.review, repeated)
    expect((await f.host.execute(f.review, repeated)).kind).toBe('recorded')
  })
  it('rejects a changed source or command review before invoking the corporate CLI', async () => {
    const f = await fixture()
    await f.approve()
    await expect(f.host.snapshot({ ...f.review, recipeDigest: 'b'.repeat(64) })).rejects.toThrow(
      'since review'
    )
    await writeFile(join(f.pluginDir, 'provider.mjs'), 'throw new Error("changed source")')
    await expect(f.host.execute(f.review, request(f.review, 'list'))).rejects.toThrow(
      'changed since'
    )
    await expect(readFile(join(f.cwd, 'started'))).rejects.toThrow()
  })
  it('withdraws the execution signal immediately when reconciliation is requested', async () => {
    const f = await fixture()
    await f.approve()
    f.control.env.PROVIDER_MODE = 'hang'
    const pending = f.host.execute(f.review, request(f.review, 'create'))
    await expect
      .poll(async () => {
        try {
          return await readFile(join(f.cwd, 'started'), 'utf8')
        } catch {
          return ''
        }
      })
      .not.toBe('')
    const reconcile = f.disable()
    await expect(pending).resolves.toMatchObject({
      kind: 'executed',
      result: { kind: 'unverifiable', reason: 'authority-changed' }
    })
    await reconcile
    await expect(f.host.snapshot(f.review)).rejects.toThrow('requires approval')
  })
  it('cancels on a host context withdrawal and preserves the uncertain operation for restart', async () => {
    const f = await fixture()
    await f.approve()
    f.control.env.PROVIDER_MODE = 'hang'
    const pending = f.host.execute(f.review, request(f.review, 'create'))
    await expect
      .poll(async () => {
        try {
          return await readFile(join(f.cwd, 'started'), 'utf8')
        } catch {
          return ''
        }
      })
      .not.toBe('')
    f.controller.abort()
    await expect(pending).resolves.toMatchObject({
      result: { kind: 'unverifiable', reason: 'authority-changed' }
    })
    f.control.signal = new AbortController().signal
    f.control.env = {}
    expect((await f.host.snapshot(f.review)).operations[0]?.status).toBe('unverifiable')
    await expect(f.host.execute(f.review, request(f.review, 'create'))).rejects.toThrow(
      'reconciled'
    )
  })
})
