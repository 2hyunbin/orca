import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  environmentRecipeRequestSchema,
  type EnvironmentRecipeRequest,
  type EnvironmentRecipeResource
} from '../../shared/environment-recipe-protocol'
import { createRequire } from 'node:module'
import { runProcess } from '@orca/process-host'
import { pluginEnvironmentRecipeSchema } from '../../shared/plugins/plugin-environment-recipe-artifact'
import {
  ENVIRONMENT_RECIPE_JOURNAL_OPERATION_LIMIT,
  environmentRecipeJournalSchema
} from '../../shared/plugins/plugin-environment-recipe-journal'
import { PluginEnvironmentRecipeJournalStore } from './plugin-environment-recipe-journal-store'
import { environmentRecipeDigest } from './plugin-environment-recipe-execution'
import { executeJournaledPluginEnvironmentRecipe } from './plugin-environment-recipe-operation'

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

describe('environment journal integration', () => {
  it('serializes real competing processes before either can execute a mutation', async () => {
    const first = request('create')
    const second = request('create')
    const moduleUrl = new URL('./plugin-environment-recipe-journal-store.ts', import.meta.url).href
    const loader = createRequire(import.meta.url).resolve('tsx')
    const run = (input: EnvironmentRecipeRequest) =>
      runProcess({
        program: process.execPath,
        args: [
          '--import',
          loader,
          '--input-type=module',
          '-e',
          `
import { PluginEnvironmentRecipeJournalStore } from ${JSON.stringify(moduleUrl)};
const journal=new PluginEnvironmentRecipeJournalStore(${JSON.stringify(root)},${JSON.stringify(binding)});
try { const result=await journal.begin(${JSON.stringify(input)});process.stdout.write(result.kind); }
catch(error) { process.stdout.write(error.message);process.exitCode=3; }`
        ],
        cwd: root,
        env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
        timeoutMs: 10000,
        maxOutputBytes: 4096,
        terminationBarrier: true
      })
    const results = await Promise.all([run(first), run(second)])
    expect(results.map((result) => result.code).sort()).toEqual([0, 3])
    expect(results.some((result) => result.stdout === 'started')).toBe(true)
    expect(results.some((result) => result.stdout.includes('already pending'))).toBe(true)
    expect((await store().snapshot()).operations).toHaveLength(1)
  })

  it('fails at receipt capacity without overwriting prior operations or starting work', async () => {
    await inventory(store())
    const journal = await store().snapshot()
    const finished = journal.operations[0]!
    journal.operations = Array.from({ length: ENVIRONMENT_RECIPE_JOURNAL_OPERATION_LIMIT }, () => ({
      ...finished,
      operationId: randomUUID()
    }))
    const file = await journalPath()
    const bytes = JSON.stringify(environmentRecipeJournalSchema.parse(journal))
    await writeFile(file, bytes)
    await expect(store().begin(request('create'))).rejects.toThrow()
    expect(await readFile(file, 'utf8')).toBe(bytes)
  })

  it('journals six real CLI actions, with restart between every operation', async () => {
    const cli = join(root, 'provider.mjs')
    await writeFile(
      cli,
      `
let raw='';for await(const chunk of process.stdin)raw+=chunk;const input=JSON.parse(raw);
const state={create:'running',list:'running',sleep:'sleeping',resume:'running',archive:'archived',delete:'deleted'}[input.action];
const resource={id:'pod',name:'Development pod',revision:input.operationId,lifetime:'ephemeral',state};
process.stdout.write(JSON.stringify({protocolVersion:1,operationId:input.operationId,providerId:input.providerId,action:input.action,
...(input.action==='list'?{kind:'inventory',resources:[resource]}:{kind:'resource',resource})}));`
    )
    const command = { program: process.execPath, args: [cli] }
    const recipe = pluginEnvironmentRecipeSchema.parse({
      schemaVersion: 1,
      id: 'devpods',
      name: 'Development pods',
      description: 'Private environments',
      lifetime: 'both',
      commands: {
        create: command,
        list: command,
        sleep: command,
        resume: command,
        archive: command,
        delete: command
      }
    })
    const owner = { ...binding, recipeDigest: environmentRecipeDigest(recipe) }
    const reopened = () => new PluginEnvironmentRecipeJournalStore(root, owner)
    for (const action of ['create', 'list', 'sleep', 'resume', 'archive', 'delete']) {
      const revision = (await reopened().snapshot()).resources[0]?.revision
      const input = request(
        action,
        revision && action !== 'list' ? { expectedRevision: revision } : {}
      )
      const execution = {
        pluginKey: 'company.platform',
        userDataPath: root,
        executionHostId: binding.executionHostId,
        sourceDigest: binding.sourceDigest,
        recipe,
        request: input,
        cwd: root,
        env: {},
        authorize: async () => ({ isCurrent: () => true, signal: new AbortController().signal })
      }
      const result = await executeJournaledPluginEnvironmentRecipe(execution)
      expect(result.kind).toBe('executed')
      if (result.kind === 'executed') {
        expect(result.result.kind).toBe('completed')
      }
      expect((await executeJournaledPluginEnvironmentRecipe(execution)).kind).toBe('recorded')
    }
    const snapshot = await reopened().snapshot()
    expect(snapshot.operations.map((operation) => operation.status)).toEqual(
      Array(6).fill('completed')
    )
    expect(snapshot.resources[0]?.state).toBe('deleted')
  })
})
