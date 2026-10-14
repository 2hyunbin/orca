import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  environmentRecipeRequestSchema,
  type EnvironmentRecipeRequest
} from '../../shared/environment-recipe-protocol'
import { pluginEnvironmentRecipeSchema } from '../../shared/plugins/plugin-environment-recipe-artifact'
import {
  environmentRecipeDigest,
  executePluginEnvironmentRecipe
} from './plugin-environment-recipe-execution'

let root: string
let program: string
const authority = () => ({ isCurrent: () => true, signal: new AbortController().signal })
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-environment-recipe-'))
  program = join(root, 'provider.mjs')
  await writeFile(
    program,
    `
import { writeFile } from 'node:fs/promises';
let input=''; for await (const chunk of process.stdin) input+=chunk;
const request=JSON.parse(input); await writeFile('request.json',input);
await writeFile('arguments.json',JSON.stringify(process.argv.slice(2)));
const mode=process.env.TEST_MODE;
if(mode==='hang'){setInterval(()=>{},1000);await new Promise(()=>{});}
if(mode==='flood'){process.stdout.write('x'.repeat(1024*1024));await new Promise(()=>{});}
if(mode==='exit'){process.stderr.write('SECRET_DIAGNOSTIC');process.exit(2);}
if(mode==='invalid'){process.stdout.write('SECRET_DIAGNOSTIC');process.exit(0);}
if(mode==='unavailable'){process.stdout.write(JSON.stringify({protocolVersion:1,operationId:request.operationId,providerId:request.providerId,action:request.action,kind:'error',code:'unavailable',message:'Backend did not confirm the operation'}));process.exit(0);}
if(mode==='slow'){await new Promise(resolve=>setTimeout(resolve,200));}
const state={create:'running',resume:'running',sleep:'sleeping',archive:'archived',delete:'deleted'}[request.action];
const resource={id:request.resourceId??'new-pod',name:'Development pod',revision:'r2',lifetime:'long-lived',state:state??'running'};
if(resource.state==='running')resource.connection={type:'ssh',host:'pod.internal',port:22,username:'developer',projectRoot:'/work'};
const response={protocolVersion:1,operationId:request.operationId,providerId:request.providerId,action:request.action,
...(request.action==='list'?{kind:'inventory',resources:[resource]}:{kind:'resource',resource})};
if(mode==='wrong'){response.operationId='12345678-1234-4234-8234-123456789abc';}
process.stdout.write(JSON.stringify(response));
`
  )
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function recipe() {
  const command = { program: process.execPath, args: [program], timeoutSeconds: 1 }
  return pluginEnvironmentRecipeSchema.parse({
    schemaVersion: 1,
    id: 'devpods',
    name: 'Development pods',
    description: 'Internal development environments',
    lifetime: 'both',
    createFields: [],
    commands: {
      create: command,
      list: command,
      delete: command,
      sleep: command,
      resume: command,
      archive: command
    }
  })
}
function request(action: string = 'list'): EnvironmentRecipeRequest {
  return environmentRecipeRequestSchema.parse({
    protocolVersion: 1,
    operationId: randomUUID(),
    providerId: 'company.platform/devpods',
    action,
    ...(action === 'create'
      ? { parameters: {} }
      : action === 'list'
        ? {}
        : { resourceId: 'pod;$(wrong)', expectedRevision: 'r1' })
  })
}
function input(action = 'list') {
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test' }
  return {
    pluginKey: 'company.platform',
    recipe: recipe(),
    request: request(action),
    cwd: root,
    env,
    authorize: vi.fn(async () => authority())
  }
}

describe('approved environment recipe execution', () => {
  it.each(['create', 'list', 'sleep', 'resume', 'archive', 'delete'])(
    'runs a real CLI for %s with operation-bound results',
    async (action) => {
      const args = input(action)
      const result = await executePluginEnvironmentRecipe(args)
      expect(result.kind).toBe('completed')
      expect(JSON.parse(await readFile(join(root, 'request.json'), 'utf8'))).toEqual(args.request)
      expect(args.authorize).toHaveBeenCalledWith(
        expect.objectContaining({
          recipeDigest: environmentRecipeDigest(args.recipe),
          providerId: args.request.providerId,
          action,
          request: args.request
        })
      )
    }
  )
  it('preserves uncertainty for an unavailable mutation even when the provider exits successfully', async () => {
    const mutation = input('create')
    mutation.env.TEST_MODE = 'unavailable'
    expect(await executePluginEnvironmentRecipe(mutation)).toEqual({
      kind: 'unverifiable',
      reason: 'provider-unavailable'
    })
    const inventory = input('list')
    inventory.env.TEST_MODE = 'unavailable'
    expect(await executePluginEnvironmentRecipe(inventory)).toMatchObject({
      kind: 'completed',
      response: { kind: 'error', code: 'unavailable' }
    })
  })
  it('never spawns without current approval and refuses already cancelled work', async () => {
    const args = input()
    expect(await executePluginEnvironmentRecipe({ ...args, authorize: async () => null })).toEqual({
      kind: 'refused',
      reason: 'approval-required'
    })
    expect(await executePluginEnvironmentRecipe({ ...args, signal: AbortSignal.abort() })).toEqual({
      kind: 'refused',
      reason: 'cancelled'
    })
    await expect(readFile(join(root, 'request.json'))).rejects.toThrow()
  })
  it('never resolves a portable runtime through PATH without a host-prepared launch', async () => {
    const args = input('list')
    args.recipe = pluginEnvironmentRecipeSchema.parse({
      schemaVersion: 1,
      protocolVersion: 2,
      id: 'devpods',
      name: 'Development pods',
      description: 'Company adapter',
      lifetime: 'both',
      commands: { list: { program: 'orca:node', entry: 'adapter.mjs', args: [] } }
    })
    args.request = environmentRecipeRequestSchema.parse({
      ...args.request,
      protocolVersion: 2,
      contextId: 'company/account'
    })
    expect(await executePluginEnvironmentRecipe(args)).toEqual({
      kind: 'refused',
      reason: 'approval-required'
    })
    await expect(readFile(join(root, 'request.json'))).rejects.toThrow()
  })
  it('keeps shell syntax, spaces and variables literal in argv', async () => {
    const args = input()
    args.recipe.commands.list.args.push(
      'one;two',
      '$(touch injection-marker)',
      '`echo no`',
      'value with spaces',
      '%TOKEN%'
    )
    expect((await executePluginEnvironmentRecipe(args)).kind).toBe('completed')
    expect(JSON.parse(await readFile(join(root, 'arguments.json'), 'utf8'))).toEqual(
      args.recipe.commands.list.args.slice(1)
    )
    await expect(readFile(join(root, 'injection-marker'))).rejects.toThrow()
  })
  it.each([
    ['hang', 'timeout'],
    ['flood', 'output-limit'],
    ['exit', 'command-failed'],
    ['invalid', 'invalid-response'],
    ['wrong', 'invalid-response']
  ])('reports an unverifiable outcome for %s without leaking raw output', async (mode, reason) => {
    const args = input('delete')
    args.env = { NODE_ENV: 'test', TEST_MODE: mode }
    const result = await executePluginEnvironmentRecipe(args)
    expect(result).toEqual({ kind: 'unverifiable', reason })
    expect(JSON.stringify(result)).not.toContain('SECRET_DIAGNOSTIC')
  })
  it('retires a command on approval revocation instead of accepting a late result', async () => {
    const controller = new AbortController()
    const args = input('resume')
    args.env = { NODE_ENV: 'test', TEST_MODE: 'hang' }
    const running = executePluginEnvironmentRecipe({
      ...args,
      authorize: async () => ({
        isCurrent: () => !controller.signal.aborted,
        signal: controller.signal
      })
    })
    setTimeout(() => controller.abort(), 100)
    expect(await running).toEqual({ kind: 'unverifiable', reason: 'authority-changed' })
  })
  it('snapshots provider commands and host launch context before asynchronous authorization', async () => {
    const args = input()
    const original = [...args.recipe.commands.list.args]
    const result = await executePluginEnvironmentRecipe({
      ...args,
      authorize: async () => {
        args.recipe.commands.list.args.push('unapproved-argument')
        return authority()
      }
    })
    expect(result.kind).toBe('completed')
    expect(JSON.parse(await readFile(join(root, 'arguments.json'), 'utf8'))).toEqual(
      original.slice(1)
    )
  })
  it('rejects another provider before asking for consent or starting a process', async () => {
    const args = input()
    args.request.providerId = 'other.platform/devpods'
    await expect(executePluginEnvironmentRecipe(args)).rejects.toThrow('another provider')
    expect(args.authorize).not.toHaveBeenCalled()
  })
})
