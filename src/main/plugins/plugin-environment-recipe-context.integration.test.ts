import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { environmentRecipeRequestSchema } from '../../shared/environment-recipe-protocol'
import { pluginEnvironmentRecipeSchema } from '../../shared/plugins/plugin-environment-recipe-artifact'
import { environmentRecipeDigest } from './plugin-environment-recipe-execution'
import { PluginEnvironmentRecipeJournalStore } from './plugin-environment-recipe-journal-store'
import { executeJournaledPluginEnvironmentRecipe } from './plugin-environment-recipe-operation'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-provider-context-'))
  await writeFile(join(root, 'active-context'), 'company-a/account-one')
  await writeFile(
    join(root, 'provider.mjs'),
    `import {readFile,writeFile} from 'node:fs/promises';
let input=''; for await(const chunk of process.stdin) input+=chunk;
const request=JSON.parse(input);
const active=await readFile('active-context','utf8');
const identity={protocolVersion:request.protocolVersion,operationId:request.operationId,
providerId:request.providerId,action:request.action,
...(request.contextId!==undefined?{contextId:request.contextId}:{})};
if(request.protocolVersion===2&&request.contextId!==active){
process.stdout.write(JSON.stringify({...identity,kind:'error',code:'conflict',message:'Provider account context changed'}));
}else{
if(request.action==='delete')await writeFile('deleted-in-context',active);
const resource={id:'pod',name:'Development pod',revision:'r1',lifetime:'long-lived',
state:request.action==='delete'?'deleted':'running'};
process.stdout.write(JSON.stringify({...identity,...(request.action==='list'?
{kind:'inventory',resources:[resource]}:{kind:'resource',resource})}));
}`
  )
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
function input(protocolVersion: 1 | 2, action: 'list' | 'delete' = 'list') {
  const command = { program: process.execPath, args: [join(root, 'provider.mjs')] }
  const recipe = pluginEnvironmentRecipeSchema.parse({
    schemaVersion: 1,
    ...(protocolVersion === 2 ? { protocolVersion: 2 } : {}),
    id: 'devpods',
    name: 'Development pods',
    description: 'Company environments',
    lifetime: 'both',
    commands: { list: command, delete: command }
  })
  return {
    userDataPath: root,
    executionHostId: 'local',
    sourceDigest: 'a'.repeat(64),
    pluginKey: 'company.platform',
    recipe,
    request: environmentRecipeRequestSchema.parse({
      protocolVersion,
      ...(protocolVersion === 2 ? { contextId: 'company-a/account-one' } : {}),
      providerId: 'company.platform/devpods',
      operationId: randomUUID(),
      action,
      ...(action === 'delete' ? { resourceId: 'pod', expectedRevision: 'r1' } : {})
    }),
    cwd: root,
    env: {},
    authorize: async () => ({ isCurrent: () => true, signal: new AbortController().signal })
  }
}
function journal(args: ReturnType<typeof input>) {
  return new PluginEnvironmentRecipeJournalStore(root, {
    executionHostId: args.executionHostId,
    providerId: args.request.providerId,
    sourceDigest: args.sourceDigest,
    recipeDigest: environmentRecipeDigest(args.recipe),
    ...(args.request.contextId !== undefined ? { contextId: args.request.contextId } : {})
  })
}

describe('provider account context with a real CLI', () => {
  it('reproduces the legacy default-context ambiguity with equal resource IDs and revisions', async () => {
    await executeJournaledPluginEnvironmentRecipe(input(1))
    await writeFile(join(root, 'active-context'), 'company-b/account-two')
    const result = await executeJournaledPluginEnvironmentRecipe(input(1, 'delete'))
    expect(result.kind).toBe('executed')
    expect(await readFile(join(root, 'deleted-in-context'), 'utf8')).toBe('company-b/account-two')
  })
  it('lets a context-aware CLI refuse that switch before deleting another account’s machine', async () => {
    await executeJournaledPluginEnvironmentRecipe(input(2))
    await writeFile(join(root, 'active-context'), 'company-b/account-two')
    const args = input(2, 'delete')
    const result = await executeJournaledPluginEnvironmentRecipe(args)
    expect(result).toMatchObject({
      kind: 'executed',
      result: { kind: 'completed', response: { kind: 'error', code: 'conflict' } }
    })
    await expect(readFile(join(root, 'deleted-in-context'))).rejects.toThrow()
    expect((await journal(args).snapshot()).resources[0]?.state).toBe('running')
  })
  it('keeps the same journal filename across context changes and refuses cached cross-context rows', async () => {
    const args = input(2)
    await executeJournaledPluginEnvironmentRecipe(args)
    const changed = input(2, 'delete')
    changed.request.contextId = 'company-b/account-two'
    await expect(executeJournaledPluginEnvironmentRecipe(changed)).rejects.toThrow(
      'different source'
    )
    await expect(readFile(join(root, 'deleted-in-context'))).rejects.toThrow()
    expect((await journal(args).snapshot()).resources).toHaveLength(1)
  })
  it('does not replay a recorded operation ID under another account context', async () => {
    const args = input(2)
    await executeJournaledPluginEnvironmentRecipe(args)
    const store = journal(args)
    await expect(
      store.begin({ ...args.request, contextId: 'company-b/account-two' })
    ).rejects.toThrow('provider context')
    expect((await store.snapshot()).operations).toHaveLength(1)
  })
  it('refuses a protocol downgrade before persisting or authorizing an operation', async () => {
    const args = input(2)
    const legacyRequest = input(1).request
    await expect(
      executeJournaledPluginEnvironmentRecipe({ ...args, request: legacyRequest })
    ).rejects.toThrow('declared version')
    expect((await journal(args).snapshot()).operations).toEqual([])
  })
})
