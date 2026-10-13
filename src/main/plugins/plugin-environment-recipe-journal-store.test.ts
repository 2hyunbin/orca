import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  environmentRecipeRequestSchema,
  type EnvironmentRecipeRequest,
  type EnvironmentRecipeResource
} from '../../shared/environment-recipe-protocol'
import { environmentRecipeJournalSchema } from '../../shared/plugins/plugin-environment-recipe-journal'
import { PluginEnvironmentRecipeJournalStore } from './plugin-environment-recipe-journal-store'

let root: string
const binding = {
  executionHostId: 'local',
  providerId: 'company.platform/devpods',
  sourceDigest: 'a'.repeat(64),
  recipeDigest: 'b'.repeat(64)
}
const resource: EnvironmentRecipeResource = {
  id: 'pod',
  name: 'Development pod',
  revision: 'r1',
  lifetime: 'long-lived',
  state: 'running',
  connection: {
    type: 'ssh',
    host: 'pod.internal',
    port: 22,
    username: 'developer',
    projectRoot: '/work'
  }
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-provider-journal-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
function store() {
  return new PluginEnvironmentRecipeJournalStore(root, binding)
}
function request(action = 'list', overrides = {}): EnvironmentRecipeRequest {
  return environmentRecipeRequestSchema.parse({
    protocolVersion: 1,
    operationId: randomUUID(),
    providerId: binding.providerId,
    action,
    ...(action === 'create'
      ? { parameters: {} }
      : action === 'list'
        ? {}
        : { resourceId: 'pod', expectedRevision: 'r1' }),
    ...overrides
  })
}
async function inventory(journal: PluginEnvironmentRecipeJournalStore, resources = [resource]) {
  const input = request()
  await journal.begin(input)
  await journal.finish(input, {
    kind: 'completed',
    response: {
      ...input,
      kind: 'inventory',
      resources
    }
  })
}
async function journalPath() {
  const directory = join(root, 'plugin-environment-recipes')
  const file = (await readdir(directory)).find((file) => file.endsWith('.json'))
  if (!file) {
    throw new Error('Journal file is missing')
  }
  return join(directory, file)
}

describe('host-owned environment operation journal', () => {
  it('durably records intent, survives restart and never restarts the same operation', async () => {
    const input = request('create', { parameters: { token: 'SENSITIVE_PARAMETER' } })
    const started = await store().begin(input)
    expect(started.kind).toBe('started')
    expect(await store().begin(input)).toEqual({ kind: 'recorded', operation: started.operation })
    expect((await store().snapshot()).operations[0]?.status).toBe('pending')
    expect(await readFile(await journalPath(), 'utf8')).not.toContain('SENSITIVE_PARAMETER')
    if (process.platform !== 'win32') {
      expect((await stat(await journalPath())).mode & 0o777).toBe(0o600)
    }
  })

  it('allows only one competing client to reserve a provider operation', async () => {
    const attempts = await Promise.allSettled([
      store().begin(request('create')),
      store().begin(request('create'))
    ])
    expect(attempts.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter((entry) => entry.status === 'rejected')).toHaveLength(1)
    expect((await store().snapshot()).operations).toHaveLength(1)
  })

  it('refuses changed source and recipe ownership without bypassing a pending intent', async () => {
    await store().begin(request('create'))
    for (const changed of [{ sourceDigest: 'c'.repeat(64) }, { recipeDigest: 'd'.repeat(64) }]) {
      await expect(
        new PluginEnvironmentRecipeJournalStore(root, { ...binding, ...changed }).snapshot()
      ).rejects.toThrow('different source')
    }
    expect(
      (await readdir(join(root, 'plugin-environment-recipes'))).filter((file) =>
        file.endsWith('.json')
      )
    ).toHaveLength(1)
  })

  it('isolates providers and execution hosts with the same resource name', async () => {
    await inventory(store())
    for (const owner of [
      { providerId: 'other.platform/devpods' },
      { executionHostId: 'ssh:other-host' }
    ]) {
      expect(
        (await new PluginEnvironmentRecipeJournalStore(root, { ...binding, ...owner }).snapshot())
          .resources
      ).toEqual([])
    }
    await expect(
      store().begin(request('list', { providerId: 'other.platform/devpods' }))
    ).rejects.toThrow('another journal owner')
  })

  it('rejects operation ID reuse with changed parameters or action', async () => {
    const input = request('create')
    await store().begin(input)
    await expect(
      store().begin(
        request('create', { operationId: input.operationId, parameters: { region: 'west' } })
      )
    ).rejects.toThrow('reused')
    await expect(
      store().begin(request('list', { operationId: input.operationId }))
    ).rejects.toThrow('reused')
  })

  it('requires a current provider revision before mutation', async () => {
    await expect(store().begin(request('sleep'))).rejects.toThrow('revision')
    await inventory(store())
    await expect(store().begin(request('sleep', { expectedRevision: 'stale' }))).rejects.toThrow(
      'revision'
    )
    expect((await store().begin(request('sleep'))).kind).toBe('started')
  })

  it('keeps previous resources on an uncertain outcome and blocks subsequent mutations', async () => {
    await inventory(store())
    const input = request('sleep')
    await store().begin(input)
    await store().finish(input, { kind: 'unverifiable', reason: 'timeout' })
    expect((await store().snapshot()).resources).toEqual([resource])
    await expect(store().begin(request('delete'))).rejects.toThrow('reconciled')
    await inventory(store(), [{ ...resource, revision: 'r2' }])
    await expect(store().begin(request('delete', { expectedRevision: 'r2' }))).rejects.toThrow(
      'reconciled'
    )
  })

  it('does not interpret missing or paginated inventory rows as deletion', async () => {
    await inventory(store())
    await inventory(store(), [])
    const input = request()
    await store().begin(input)
    await store().finish(input, {
      kind: 'completed',
      response: { ...input, kind: 'inventory', resources: [], nextCursor: 'page-2' }
    })
    expect((await store().snapshot()).resources).toEqual([resource])
  })

  it('rejects an unrelated completion and preserves its pending intent', async () => {
    const input = request('create')
    await store().begin(input)
    await expect(
      store().finish(input, {
        kind: 'completed',
        response: {
          protocolVersion: 1,
          operationId: randomUUID(),
          providerId: binding.providerId,
          action: 'create',
          kind: 'resource',
          resource
        }
      })
    ).rejects.toThrow('this operation')
    expect((await store().snapshot()).operations[0]?.status).toBe('pending')
    await expect(
      store().finish(request('create'), { kind: 'refused', reason: 'approval-required' })
    ).rejects.toThrow('no durable')
  })

  it('records exact repeated completions and rejects contradictory outcomes', async () => {
    const input = request('create')
    await store().begin(input)
    const result = { kind: 'refused', reason: 'approval-required' } as const
    const completed = await store().finish(input, result)
    expect(await store().finish(input, result)).toEqual(completed)
    await expect(
      store().finish(input, { kind: 'unverifiable', reason: 'timeout' })
    ).rejects.toThrow('contradicts')
    expect((await store().begin(request('create'))).kind).toBe('started')
  })

  it('retains an explicit deletion tombstone and refuses further mutation', async () => {
    await inventory(store())
    const input = request('delete')
    await store().begin(input)
    await store().finish(input, {
      kind: 'completed',
      response: {
        protocolVersion: 1,
        operationId: input.operationId,
        providerId: binding.providerId,
        action: 'delete',
        kind: 'resource',
        resource: { ...resource, connection: undefined, revision: 'r2', state: 'deleted' }
      }
    })
    await expect(store().begin(request('resume', { expectedRevision: 'r2' }))).rejects.toThrow(
      'revision'
    )
    await inventory(store(), [])
    expect((await store().snapshot()).resources[0]?.state).toBe('deleted')
  })

  it.each(['{broken', JSON.stringify({ version: 99, operations: [] })])(
    'fails closed on unreadable or future journal formats (%s)',
    async (bytes) => {
      await inventory(store())
      const file = await journalPath()
      await writeFile(file, bytes)
      await expect(store().begin(request('create'))).rejects.toThrow()
      expect(await readFile(file, 'utf8')).toBe(bytes)
    }
  )

  it('rejects duplicate identities and competing intents in persisted data', () => {
    const operation = {
      operationId: randomUUID(),
      requestDigest: 'e'.repeat(64),
      action: 'create',
      startedAt: 1,
      status: 'pending'
    }
    for (const changes of [
      { resources: [resource, resource] },
      { operations: [operation, operation] },
      { operations: [operation, { ...operation, operationId: randomUUID() }] }
    ]) {
      expect(
        environmentRecipeJournalSchema.safeParse({
          version: 1,
          binding,
          resources: [],
          operations: [],
          ...changes
        }).success
      ).toBe(false)
    }
  })

  it('isolates returned snapshots from later durable state', async () => {
    await inventory(store())
    const snapshot = await store().snapshot()
    snapshot.resources[0]!.revision = 'forged'
    snapshot.binding.sourceDigest = 'f'.repeat(64)
    expect((await store().snapshot()).resources[0]?.revision).toBe('r1')
    expect((await store().snapshot()).binding.sourceDigest).toBe(binding.sourceDigest)
  })
})
