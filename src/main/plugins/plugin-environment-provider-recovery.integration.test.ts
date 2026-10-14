import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createPluginEnvironmentProviderInstallFixture as fixture,
  disposePluginEnvironmentProviderInstallFixtures
} from './plugin-environment-provider-install-fixture'
import { PluginEnvironmentRecipeJournalStore } from './plugin-environment-recipe-journal-store'
import { environmentRecipeRequestSchema } from '../../shared/environment-recipe-protocol'
import { isEnvironmentRecipeOperationUnresolved } from '../../shared/plugins/plugin-environment-recipe-journal'
afterEach(disposePluginEnvironmentProviderInstallFixtures)
async function configured(options: Parameters<typeof fixture>[0] = {}) {
  const f = await fixture(options)
  await f.approve()
  await f.service.environmentProviders.configure(f.review)
  const create = environmentRecipeRequestSchema.parse({
    protocolVersion: 2,
    providerId: f.review.providerId,
    contextId: f.review.contextId,
    operationId: randomUUID(),
    action: 'create',
    parameters: {}
  })
  return { ...f, create }
}
describe('installed provider recovery runs only its reviewed receipt command', () => {
  it.each([false, true])(
    'recovers a creation applied before its response was lost, preserving original failure across restart and never creating again (portable=%s)',
    async (portable) => {
      const f = await configured({ portable, recovery: true, loseCreateResponse: true })
      const cancelled = new AbortController()
      const pending = f.service.environmentProviders.execute(f.review, f.create, cancelled.signal)
      await expect
        .poll(async () => {
          try {
            return JSON.parse(await readFile(join(f.cwd, 'receipts.json'), 'utf8'))[
              f.create.operationId
            ]?.outcome?.kind
          } catch {
            return null
          }
        })
        .toBe('completed')
      cancelled.abort()
      expect(await pending).toMatchObject({
        kind: 'executed',
        result: { kind: 'unverifiable', reason: 'cancelled' }
      })
      await f.service.dispose()
      const reopened = await f.reopen()
      const result = await reopened.environmentProviders.recover({
        review: f.review,
        originalOperationId: f.create.operationId,
        queryId: randomUUID()
      })
      expect(result).toMatchObject({
        kind: 'inspected',
        result: {
          kind: 'completed',
          response: { kind: 'receipt', outcome: { resource: { id: 'sandbox' } } }
        },
        operation: {
          status: 'unverifiable',
          reason: 'cancelled',
          recovery: { inventoryConfirmed: true }
        }
      })
      const history = await reopened.environmentProviders.snapshot(f.review)
      expect(history.resources).toMatchObject([{ id: 'sandbox', state: 'running' }])
      expect(isEnvironmentRecipeOperationUnresolved(history.operations[0]!)).toBe(false)
      const processBefore = await readFile(join(f.cwd, 'started'), 'utf8')
      expect(await reopened.environmentProviders.execute(f.review, f.create)).toMatchObject({
        kind: 'recorded'
      })
      expect(
        await reopened.environmentProviders.recover({
          review: f.review,
          originalOperationId: f.create.operationId,
          queryId: randomUUID()
        })
      ).toMatchObject({ kind: 'known' })
      expect(await readFile(join(f.cwd, 'started'), 'utf8')).toBe(processBefore)
    }
  )
  it('keeps a pending operation fenced when the provider has no authoritative receipt', async () => {
    const f = await configured({ recovery: true })
    await new PluginEnvironmentRecipeJournalStore(
      f.service.options.userDataPath,
      f.control.binding
    ).begin(f.create)
    const result = await f.service.environmentProviders.recover({
      review: f.review,
      originalOperationId: f.create.operationId,
      queryId: randomUUID()
    })
    expect(result).toMatchObject({
      kind: 'inspected',
      result: { kind: 'completed', response: { kind: 'unknown' } },
      operation: { status: 'pending' }
    })
    await expect(
      f.service.environmentProviders.execute(f.review, { ...f.create, operationId: randomUUID() })
    ).rejects.toThrow('unresolved')
    expect(
      (await f.service.environmentProviders.snapshot(f.review)).operations[0]?.recovery
    ).toBeUndefined()
  })
  it('does not execute a receipt query when recovery was not declared or current source/account authority is missing', async () => {
    const f = await configured()
    await new PluginEnvironmentRecipeJournalStore(
      f.service.options.userDataPath,
      f.control.binding
    ).begin(f.create)
    expect(
      await f.service.environmentProviders.recover({
        review: f.review,
        originalOperationId: f.create.operationId,
        queryId: randomUUID()
      })
    ).toMatchObject({
      kind: 'inspected',
      result: { kind: 'refused', reason: 'unsupported-action' }
    })
    await expect(readFile(join(f.cwd, 'started'))).rejects.toThrow()
    await expect(
      f.service.environmentProviders.recover({
        review: { ...f.review, contextId: 'other-account' },
        originalOperationId: f.create.operationId,
        queryId: randomUUID()
      })
    ).rejects.toThrow('context')
    await f.disable()
    await expect(
      f.service.environmentProviders.recover({
        review: f.review,
        originalOperationId: f.create.operationId,
        queryId: randomUUID()
      })
    ).rejects.toThrow('approval')
  })
  it.each([
    ['sleep', 'sleeping'],
    ['resume', 'running'],
    ['archive', 'archived'],
    ['delete', 'deleted']
  ] as const)(
    'recovers %s from its own operation receipt without replaying the mutation',
    async (action, state) => {
      const f = await configured({ recovery: true, loseResponseAction: action })
      if (action === 'resume') {
        await writeFile(
          join(f.cwd, 'backend.json'),
          JSON.stringify({
            devbox: {
              id: 'devbox',
              name: 'Devbox',
              revision: 'r1',
              lifetime: 'long-lived',
              state: 'sleeping'
            }
          })
        )
      }
      await f.service.environmentProviders.execute(
        f.review,
        environmentRecipeRequestSchema.parse({
          protocolVersion: 2,
          contextId: f.review.contextId,
          providerId: f.review.providerId,
          operationId: randomUUID(),
          action: 'list'
        })
      )
      const request = environmentRecipeRequestSchema.parse({
        protocolVersion: 2,
        contextId: f.review.contextId,
        providerId: f.review.providerId,
        operationId: randomUUID(),
        action,
        resourceId: 'devbox',
        expectedRevision: 'r1'
      })
      const stopped = new AbortController()
      const pending = f.service.environmentProviders.execute(f.review, request, stopped.signal)
      await expect
        .poll(async () => {
          try {
            return JSON.parse(await readFile(join(f.cwd, 'receipts.json'), 'utf8'))[
              request.operationId
            ]?.outcome?.resource?.state
          } catch {
            return null
          }
        })
        .toBe(state)
      stopped.abort()
      expect(await pending).toMatchObject({ result: { kind: 'unverifiable' } })
      const result = await f.service.environmentProviders.recover({
        review: f.review,
        queryId: randomUUID(),
        originalOperationId: request.operationId
      })
      expect(result).toMatchObject({
        kind: 'inspected',
        operation: {
          status: 'unverifiable',
          recovery: { receipt: { outcome: { resource: { id: 'devbox', state } } } }
        }
      })
      expect((await f.service.environmentProviders.snapshot(f.review)).resources).toMatchObject([
        { id: 'devbox', state }
      ])
      expect(await f.service.environmentProviders.execute(f.review, request)).toMatchObject({
        kind: 'recorded'
      })
      expect(Object.keys(JSON.parse(await readFile(join(f.cwd, 'receipts.json'), 'utf8')))).toEqual(
        [request.operationId]
      )
    }
  )
})
