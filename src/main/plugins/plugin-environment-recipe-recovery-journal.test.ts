import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { environmentRecipeRequestSchema } from '../../shared/environment-recipe-protocol'
import { environmentRecipeRecoveryReceiptSchema } from '../../shared/environment-recipe-recovery-protocol'
import { isEnvironmentRecipeOperationUnresolved } from '../../shared/plugins/plugin-environment-recipe-journal'
import { PluginEnvironmentRecipeJournalStore } from './plugin-environment-recipe-journal-store'
const roots: string[] = []
const binding = {
  executionHostId: 'local',
  providerId: 'company.platform/pods',
  contextId: 'company/account',
  sourceDigest: 'a'.repeat(64),
  recipeDigest: 'b'.repeat(64)
}
const resource = {
  id: 'sandbox',
  name: 'Sandbox',
  revision: 'r1',
  lifetime: 'ephemeral' as const,
  state: 'running' as const
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-recovery-journal-'))
  roots.push(root)
  const journal = new PluginEnvironmentRecipeJournalStore(root, binding)
  const create = environmentRecipeRequestSchema.parse({
    protocolVersion: 2,
    contextId: binding.contextId,
    providerId: binding.providerId,
    operationId: randomUUID(),
    action: 'create',
    parameters: {}
  })
  const original = await journal.begin(create)
  const prepared = await journal.recoveryRequest(create.operationId, randomUUID())
  if (!prepared.request) {
    throw new Error('The pending operation needs recovery')
  }
  const receipt = environmentRecipeRecoveryReceiptSchema.parse({
    ...prepared.request,
    kind: 'receipt',
    outcome: { kind: 'completed', resource },
    currentResource: resource
  })
  return { root, journal, create, original: original.operation, query: prepared.request, receipt }
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
describe('recovery settles backend uncertainty without erasing the interrupted observation', () => {
  it('records a verified receipt alongside the original pending intent and permits a later operation after restart', async () => {
    const f = await fixture()
    const settled = await f.journal.recordRecoveryReceipt(f.query, f.receipt, {
      isCurrent: () => true
    })
    expect(settled.status).toBe('pending')
    expect(settled.requestDigest).toBe(f.original.requestDigest)
    expect(isEnvironmentRecipeOperationUnresolved(settled)).toBe(false)
    const reopened = new PluginEnvironmentRecipeJournalStore(f.root, binding)
    expect((await reopened.snapshot()).resources).toEqual([resource])
    expect((await reopened.begin(f.create)).kind).toBe('recorded')
    const next = environmentRecipeRequestSchema.parse({ ...f.create, operationId: randomUUID() })
    expect((await reopened.begin(next)).kind).toBe('started')
  })
  it('refuses wrong operation/account/digest and lost authority without changing history', async () => {
    const f = await fixture()
    await expect(
      f.journal.recordRecoveryReceipt(
        f.query,
        { ...f.receipt, contextId: 'other-account' },
        { isCurrent: () => true }
      )
    ).rejects.toThrow('account')
    await expect(
      f.journal.recordRecoveryReceipt(f.query, f.receipt, { isCurrent: () => false })
    ).rejects.toThrow('authority')
    expect((await f.journal.snapshot()).operations[0]).toEqual(f.original)
  })
  it('does not replace newer cached inventory with the original operation result when current inventory is missing', async () => {
    const f = await fixture()
    const { currentResource: _current, ...receipt } = f.receipt
    const operation = await f.journal.recordRecoveryReceipt(f.query, receipt, {
      isCurrent: () => true
    })
    expect(operation.recovery?.inventoryConfirmed).toBe(false)
    expect((await f.journal.snapshot()).resources).toEqual([])
    const list = environmentRecipeRequestSchema.parse({
      protocolVersion: 2,
      contextId: binding.contextId,
      providerId: binding.providerId,
      operationId: randomUUID(),
      action: 'list'
    })
    await f.journal.begin(list)
    await f.journal.finish(list, {
      kind: 'completed',
      response: {
        ...list,
        action: 'list',
        kind: 'inventory',
        resources: [{ ...resource, revision: 'current-r5' }]
      }
    })
    expect((await f.journal.snapshot()).operations[0]?.recovery?.inventoryConfirmed).toBe(true)
    expect((await f.journal.snapshot()).resources[0]?.revision).toBe('current-r5')
  })
  it('refuses contradictory second receipts and a late original response that would overwrite a newer backend state', async () => {
    const f = await fixture()
    const current = { ...resource, revision: 'r3', state: 'archived' as const }
    await f.journal.recordRecoveryReceipt(
      f.query,
      { ...f.receipt, currentResource: current },
      { isCurrent: () => true }
    )
    await expect(
      f.journal.recordRecoveryReceipt(
        f.query,
        {
          ...f.receipt,
          currentResource: undefined,
          outcome: { kind: 'refused', code: 'conflict' }
        },
        { isCurrent: () => true }
      )
    ).rejects.toThrow('contradicts')
    const response = {
      protocolVersion: 2 as const,
      contextId: binding.contextId,
      providerId: binding.providerId,
      operationId: f.create.operationId,
      action: 'create' as const,
      kind: 'resource' as const,
      resource
    }
    await f.journal.finish(f.create, { kind: 'completed', response })
    expect((await f.journal.snapshot()).resources).toEqual([current])
  })
  it('supersedes only an interrupted inventory read and refuses its late response without inventing machine changes', async () => {
    const f = await fixture()
    await f.journal.recordRecoveryReceipt(f.query, f.receipt, { isCurrent: () => true })
    const first = environmentRecipeRequestSchema.parse({
      protocolVersion: 2,
      contextId: binding.contextId,
      providerId: binding.providerId,
      operationId: randomUUID(),
      action: 'list'
    })
    await f.journal.begin(first)
    const next = environmentRecipeRequestSchema.parse({ ...first, operationId: randomUUID() })
    await f.journal.begin(next)
    const old = (await f.journal.snapshot()).operations.find(
      (entry) => entry.operationId === first.operationId
    )
    expect(old).toMatchObject({ status: 'unverifiable', reason: 'inventory-superseded' })
    await expect(
      f.journal.finish(first, {
        kind: 'completed',
        response: {
          ...first,
          action: 'list',
          kind: 'inventory',
          resources: [{ ...resource, revision: 'stale' }]
        }
      })
    ).rejects.toThrow('contradicts')
    expect((await f.journal.snapshot()).resources).toEqual([resource])
  })
})
