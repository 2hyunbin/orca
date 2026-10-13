import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ENVIRONMENT_RECIPE_ACTIONS,
  type EnvironmentRecipeResource
} from '../../../src/shared/environment-recipe-protocol'

export async function writePluginEnvironmentPackageFixture(
  directory: string,
  marker: string,
  connection?: EnvironmentRecipeResource['connection'],
  recovery?: { interruptCreate: boolean }
): Promise<void> {
  await mkdir(join(directory, 'recipes'), { recursive: true })
  await writeFile(
    join(directory, 'orca-plugin.json'),
    JSON.stringify({
      manifestVersion: 2,
      execution: 'instructional',
      publisher: 'stablyai',
      id: 'orca-environments-devpods',
      name: 'Development environments',
      version: '1.0.0',
      pluginApi: 1,
      engines: { orca: '>=1.4.0' },
      description:
        'Manage long-lived development machines and ephemeral sandboxes through your company CLI.',
      contributes: { environmentRecipes: [{ path: 'recipes/devpods.json' }] }
    })
  )
  await writeFile(
    join(directory, 'recipes/devpods.json'),
    JSON.stringify({
      ...(recovery
        ? {
            recovery: {
              protocolVersion: 1,
              command: {
                program: process.execPath,
                args: [
                  '-e',
                  `const fs=require('node:fs');process.stdin.setEncoding('utf8');let raw='';process.stdin.on('data',x=>raw+=x);process.stdin.on('end',()=>{const request=JSON.parse(raw),identity={protocolVersion:1,queryId:request.queryId,providerId:request.providerId,contextId:request.contextId,operation:request.operation};if(request.contextId!=='company/account/region'){process.stdout.write(JSON.stringify({...identity,kind:'error',code:'authentication-required'}));return;}const saved=JSON.parse(fs.readFileSync(${JSON.stringify(`${marker}.receipts.json`)},'utf8'))[request.operation.operationId];const resources=JSON.parse(fs.readFileSync(${JSON.stringify(`${marker}.inventory.json`)},'utf8'));const response=!saved?{kind:'unknown'}:saved.contextId!==request.contextId||saved.digest!==request.operation.requestDigest?{kind:'error',code:'unsupported'}:{kind:'receipt',outcome:saved.outcome,...(resources[saved.resourceId]?{currentResource:resources[saved.resourceId]}:{})};process.stdout.write(JSON.stringify({...identity,...response}));});`
                ],
                timeoutSeconds: 120
              }
            }
          }
        : {}),
      schemaVersion: 1,
      protocolVersion: 2,
      id: 'devpods',
      name: 'Development pods',
      description: 'Company development machines',
      lifetime: 'both',
      createFields: [{ id: 'region', label: 'Region', required: false, choices: ['east', 'west'] }],
      commands: Object.fromEntries(
        ENVIRONMENT_RECIPE_ACTIONS.map((action) => [
          action,
          {
            program: process.execPath,
            args: [
              '-e',
              `const fs=require('node:fs');
process.stdin.setEncoding('utf8');let raw='';process.stdin.on('data',chunk=>raw+=chunk);process.stdin.on('end',()=>{
const request=JSON.parse(raw);const identity={protocolVersion:2,contextId:request.contextId,operationId:request.operationId,providerId:request.providerId,action:request.action};
if(request.contextId!=='company/account/region'){process.stdout.write(JSON.stringify({...identity,kind:'error',code:'conflict',message:'Account context mismatch'}));return;}
fs.appendFileSync(${JSON.stringify(marker)},String(process.pid)+'\\n');
const ssh=${JSON.stringify(connection)};
const file=${JSON.stringify(`${marker}.inventory.json`)};
const resources=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{devbox:{id:'devbox',name:'Existing development machine',revision:'r1',lifetime:'long-lived',state:'running',...(ssh?{connection:ssh}:{})}};
let response;if(request.action==='list'){response={kind:'inventory',resources:Object.values(resources)}}else{
const selected=request.action==='create'?{id:'sandbox',name:'Temporary sandbox',lifetime:'ephemeral'}:resources[request.resourceId];
if(!selected||(request.action!=='create'&&selected.revision!==request.expectedRevision)){response={kind:'error',code:'conflict',message:'Machine revision changed'}}else{
const resource={...selected,revision:request.operationId,state:{create:'running',sleep:'sleeping',resume:'running',archive:'archived',delete:'deleted'}[request.action]};if(resource.id==='devbox'&&resource.state==='running'&&ssh)resource.connection=ssh;else delete resource.connection;resources[resource.id]=resource;response={kind:'resource',resource};}}
fs.writeFileSync(file,JSON.stringify(resources));
if(request.action!=='list'){
const receiptFile=${JSON.stringify(`${marker}.receipts.json`)};
const receipts=fs.existsSync(receiptFile)?JSON.parse(fs.readFileSync(receiptFile,'utf8')):{};
receipts[request.operationId]={contextId:request.contextId,digest:require('node:crypto').createHash('sha256').update(raw).digest('hex'),outcome:response.kind==='resource'?{kind:'completed',resource:response.resource}:{kind:'refused',code:response.code},resourceId:response.resource?.id??request.resourceId};
fs.writeFileSync(receiptFile,JSON.stringify(receipts));
if(${JSON.stringify(Boolean(recovery?.interruptCreate))}&&request.action==='create'){setInterval(()=>{},1000);return;}}
process.stdout.write(JSON.stringify({...identity,...response}));});`,
              action
            ],
            timeoutSeconds: 120
          }
        ])
      )
    })
  )
}
