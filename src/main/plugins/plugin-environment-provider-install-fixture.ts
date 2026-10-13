import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pluginEnvironmentRecipeSchema } from '../../shared/plugins/plugin-environment-recipe-artifact'
import { PluginService } from './plugin-service'
import { installPluginFromLocalPath } from './plugin-install'
import { getUserPluginsDir } from './plugin-discovery'
import {
  PluginEnvironmentRecipeHost,
  type PluginEnvironmentRecipeControlContext,
  type PluginEnvironmentRecipeReview
} from './plugin-environment-recipe-host'
import { buildPluginEnvironmentRecipeBinding } from './plugin-environment-recipe-binding'
import { environmentRecipeDigest } from './plugin-environment-recipe-execution'

const roots: string[] = []
const services: PluginService[] = []
export async function disposePluginEnvironmentProviderInstallFixtures(): Promise<void> {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
}
export async function createPluginEnvironmentProviderInstallFixture(
  options: {
    pageSize?: number
    retireConnections?: (providerId: string, resourceId?: string) => Promise<void>
    recovery?: boolean
    loseCreateResponse?: boolean
    loseResponseAction?: 'sleep' | 'resume' | 'archive' | 'delete'
  } = {}
) {
  const root = await mkdtemp(join(tmpdir(), 'orca-provider-host-'))
  roots.push(root)
  const pluginDir = join(root, 'plugin')
  const cwd = join(root, 'control')
  await Promise.all([mkdir(pluginDir), mkdir(cwd)])
  const program = join(pluginDir, 'provider.mjs')
  await writeFile(
    program,
    `import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const directory=process.env.PROVIDER_BACKEND_DIRECTORY??'.';
const startedFile=join(directory,'started');
const backendFile=join(directory,'backend.json');
const receiptsFile=join(directory,'receipts.json');
process.stdin.setEncoding('utf8');let raw='';for await(const chunk of process.stdin)raw+=chunk;
const request=JSON.parse(raw);
if(request.contextId!==(process.env.PROVIDER_CONTEXT_ID??'company/account/region')){
const identity=request.queryId?{protocolVersion:1,queryId:request.queryId,providerId:request.providerId,contextId:request.contextId,operation:request.operation}:{protocolVersion:2,operationId:request.operationId,providerId:request.providerId,contextId:request.contextId,action:request.action};
process.stdout.write(JSON.stringify({...identity,kind:'error',code:'authentication-required',...(request.queryId?{}:{message:'Account context mismatch'})}));process.exit(0);}
await writeFile(startedFile,String(process.pid));
if(process.env.PROVIDER_MODE==='hang'){setInterval(()=>{},1000);await new Promise(()=>{});}
const backend=JSON.parse(await readFile(backendFile,'utf8'));
let receipts={};try{receipts=JSON.parse(await readFile(receiptsFile,'utf8'));}catch{}
if(request.queryId){
const identity={protocolVersion:1,queryId:request.queryId,providerId:request.providerId,contextId:request.contextId,operation:request.operation};
const saved=receipts[request.operation.operationId];
const response=!saved?{kind:'unknown'}:saved.contextId!==request.contextId||saved.digest!==request.operation.requestDigest?{kind:'error',code:'unsupported'}:{kind:'receipt',outcome:saved.outcome,...(saved.resourceId&&backend[saved.resourceId]?{currentResource:backend[saved.resourceId]}:{})};
process.stdout.write(JSON.stringify({...identity,...response}));process.exit(0);
} 
const identity={protocolVersion:2,contextId:request.contextId,providerId:request.providerId,
operationId:request.operationId,action:request.action};
let response;
if(request.action==='list'){const start=Number(request.cursor??0),rows=Object.values(backend),size=Number(process.env.PROVIDER_PAGE_SIZE??rows.length);response={kind:'inventory',resources:rows.slice(start,start+size),...(start+size<rows.length?{nextCursor:String(start+size)}:{})};}
else{
let resource=request.action==='create'?{id:'sandbox',name:'New sandbox',lifetime:'ephemeral'}:backend[request.resourceId];
if(!resource||(request.action!=='create'&&resource.revision!==request.expectedRevision)){
response={kind:'error',code:'conflict',message:'Environment revision changed'};
}else{
resource={...resource,revision:request.operationId,state:{create:'running',sleep:'sleeping',resume:'running',archive:'archived',delete:'deleted'}[request.action]};
if(resource.state!=='running')delete resource.connection;
backend[resource.id]=resource;await writeFile(backendFile,JSON.stringify(backend));
response={kind:'resource',resource};
}}
if(request.action!=='list'){
const outcome=response.kind==='resource'?{kind:'completed',resource:response.resource}:{kind:'refused',code:response.code};
receipts[request.operationId]={contextId:request.contextId,digest:createHash('sha256').update(raw).digest('hex'),outcome,resourceId:response.resource?.id??request.resourceId};
await writeFile(receiptsFile,JSON.stringify(receipts));
if((request.action==='create'&&process.env.PROVIDER_LOSE_CREATE==='1')||request.action===process.env.PROVIDER_LOSE_ACTION){setInterval(()=>{},1000);await new Promise(()=>{});}
}
process.stdout.write(JSON.stringify({...identity,...response}));`
  )
  const command = {
    program: process.execPath,
    args: ['--input-type=module', '--eval', await readFile(program, 'utf8')]
  }
  const recipe = pluginEnvironmentRecipeSchema.parse({
    schemaVersion: 1,
    protocolVersion: 2,
    id: 'devpods',
    name: 'Development pods',
    description: 'Company environments',
    lifetime: 'both',
    ...(options.recovery ? { recovery: { protocolVersion: 1, command } } : {}),
    commands: {
      list: command,
      create: command,
      sleep: command,
      resume: command,
      archive: command,
      delete: command
    }
  })
  await writeFile(join(pluginDir, 'recipe.json'), JSON.stringify(recipe))
  await writeFile(
    join(pluginDir, 'orca-plugin.json'),
    JSON.stringify({
      manifestVersion: 2,
      execution: 'instructional',
      publisher: 'company',
      id: 'platform',
      name: 'Company platform',
      version: '1.0.0',
      engines: { orca: '>=1.4.0' },
      pluginApi: 1,
      contributes: { environmentRecipes: [{ path: 'recipe.json' }] }
    })
  )
  await writeFile(
    join(cwd, 'backend.json'),
    JSON.stringify({
      devbox: {
        id: 'devbox',
        name: 'Existing devbox',
        revision: 'r1',
        lifetime: 'long-lived',
        state: 'running'
      }
    })
  )
  let backendDirectory = cwd
  let backendContext = 'company/account/region'
  let enabled = true
  const consents: Record<string, string> = {}
  const service = new PluginService({
    userDataPath: join(root, 'user-data'),
    hostVersion: '1.4.0',
    retireEnvironmentProviderConnections: options.retireConnections,
    getEnvironmentRecipeLaunchEnvironment: async () => ({
      PROVIDER_BACKEND_DIRECTORY: backendDirectory,
      PROVIDER_CONTEXT_ID: backendContext,
      ...(options.pageSize ? { PROVIDER_PAGE_SIZE: String(options.pageSize) } : {}),
      ...(options.loseCreateResponse ? { PROVIDER_LOSE_CREATE: '1' } : {}),
      ...(options.loseResponseAction ? { PROVIDER_LOSE_ACTION: options.loseResponseAction } : {})
    }),
    isPluginSystemEnabled: () => enabled,
    getDisabledPlugins: () => [],
    getPluginConsents: () => consents,
    getDevPluginPaths: () => []
  })
  services.push(service)
  const installed = await installPluginFromLocalPath({
    pluginsDir: getUserPluginsDir(service.options.userDataPath),
    sourcePath: pluginDir,
    hostVersion: service.options.hostVersion
  })
  if (!installed.ok) {
    throw new Error(installed.error)
  }
  await service.initialize()
  const plugin = service.findValidPlugin('company.platform')
  if (!plugin?.reviewRevision) {
    throw new Error('Provider fixture was not discovered')
  }
  const review: PluginEnvironmentRecipeReview = {
    providerId: 'company.platform/devpods',
    contextId: 'company/account/region',
    consentFingerprint: plugin.consentFingerprint,
    reviewRevision: plugin.reviewRevision,
    recipeDigest: environmentRecipeDigest(recipe)
  }
  const controller = new AbortController()
  const control: PluginEnvironmentRecipeControlContext = {
    binding: buildPluginEnvironmentRecipeBinding(plugin, recipe, review.contextId),
    contextId: review.contextId,
    cwd,
    env: {},
    signal: controller.signal,
    isCurrent: () => true
  }
  const host = new PluginEnvironmentRecipeHost({
    service,
    userDataPath: service.options.userDataPath,
    controlContext: async () => control
  })
  return {
    root,
    pluginDir: plugin.rootDir,
    sourceDir: pluginDir,
    cwd,
    service,
    host,
    review,
    control,
    controller,
    selectBackendAccount: async (contextId: string) => {
      backendContext = contextId
      backendDirectory = join(cwd, 'accounts', Buffer.from(contextId).toString('hex'))
      await mkdir(backendDirectory, { recursive: true })
      await writeFile(
        join(backendDirectory, 'backend.json'),
        JSON.stringify({
          devbox: {
            id: 'devbox',
            name: 'Other account devbox',
            revision: 'r1',
            lifetime: 'long-lived',
            state: 'running'
          }
        })
      )
    },
    reopen: async () => {
      const reopened = new PluginService(service.options)
      services.push(reopened)
      await reopened.initialize()
      return reopened
    },
    reinstall: async () => {
      const result = await installPluginFromLocalPath({
        pluginsDir: getUserPluginsDir(service.options.userDataPath),
        sourcePath: pluginDir,
        hostVersion: service.options.hostVersion
      })
      if (!result.ok) {
        throw new Error(result.error)
      }
      await service.refresh()
    },
    approve: async () => {
      const current = service.findValidPlugin(plugin.pluginKey)
      if (!current) {
        throw new Error('Provider disappeared')
      }
      consents[current.pluginKey] = current.consentFingerprint
      await service.reconcileActivationState()
    },
    disable: () => {
      enabled = false
      return service.reconcileActivationState()
    }
  }
}
