import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { pluginEnvironmentRecipeSchema } from '../../shared/plugins/plugin-environment-recipe-artifact'
import { environmentRecipeRecoveryRequestSchema } from '../../shared/environment-recipe-recovery-protocol'
import type { EnvironmentCommandInvocation } from './plugin-environment-command-execution'
import type { EnvironmentRecipeRecoveryRequest } from '../../shared/environment-recipe-recovery-protocol'
import { executePluginEnvironmentRecovery } from './plugin-environment-recovery-execution'
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture(kind: 'receipt' | 'unknown' = 'receipt') {
  const cwd = await mkdtemp(join(tmpdir(), 'orca-receipt-command-'))
  roots.push(cwd)
  const marker = join(cwd, 'lookup.json'),
    mutation = join(cwd, 'mutation')
  const script = `const fs=require('node:fs');process.stdin.setEncoding('utf8');let raw='';process.stdin.on('data',x=>raw+=x);process.stdin.on('end',()=>{const q=JSON.parse(raw);fs.writeFileSync(${JSON.stringify(marker)},raw);process.stdout.write(JSON.stringify({...q,kind:${JSON.stringify(kind)},...( ${JSON.stringify(kind)}==='receipt'?{outcome:{kind:'refused',code:'conflict'}}:{} )}));});`
  const recipe = pluginEnvironmentRecipeSchema.parse({
    schemaVersion: 1,
    protocolVersion: 2,
    id: 'pods',
    name: 'Company pods',
    description: 'Machines',
    lifetime: 'both',
    commands: {
      list: {
        program: process.execPath,
        args: [
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(mutation)},'list executed')`
        ],
        timeoutSeconds: 30
      },
      create: {
        program: process.execPath,
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(mutation)},'executed')`],
        timeoutSeconds: 30
      }
    },
    recovery: {
      protocolVersion: 1,
      command: { program: process.execPath, args: ['-e', script], timeoutSeconds: 30 }
    }
  })
  const request = environmentRecipeRecoveryRequestSchema.parse({
    protocolVersion: 1,
    queryId: randomUUID(),
    providerId: 'company.platform/pods',
    contextId: 'company/account',
    operation: { operationId: randomUUID(), requestDigest: 'a'.repeat(64), action: 'create' }
  })
  const controller = new AbortController()
  const authorize = vi.fn(
    async (_invocation: EnvironmentCommandInvocation<EnvironmentRecipeRecoveryRequest>) => ({
      isCurrent: () => true,
      signal: controller.signal
    })
  )
  const input = {
    pluginKey: 'company.platform',
    recipe,
    request,
    cwd,
    env: { ...process.env },
    authorize
  }
  return { input, marker, mutation, controller }
}
it('runs a separately reviewed receipt command using exact newline JSON and never replays creation', async () => {
  const f = await fixture()
  expect(await executePluginEnvironmentRecovery(f.input)).toMatchObject({
    kind: 'completed',
    response: { kind: 'receipt', outcome: { kind: 'refused', code: 'conflict' } }
  })
  const raw = await readFile(f.marker, 'utf8')
  expect(raw).toBe(`${JSON.stringify(f.input.request)}\n`)
  const invocation = f.input.authorize.mock.calls[0]?.[0]
  expect(invocation).toMatchObject({
    action: 'inspect-operation',
    operationId: f.input.request.queryId,
    requestDigest: createHash('sha256').update(raw).digest('hex')
  })
  expect(JSON.parse(raw).operation).not.toHaveProperty('parameters')
  await expect(access(f.mutation)).rejects.toThrow()
})
it('preserves an unknown provider result instead of manufacturing a terminal receipt', async () => {
  const f = await fixture('unknown')
  expect(await executePluginEnvironmentRecovery(f.input)).toMatchObject({
    kind: 'completed',
    response: { kind: 'unknown' }
  })
  await expect(access(f.mutation)).rejects.toThrow()
})
it('refuses absent support before host authorization or any process launch', async () => {
  const f = await fixture()
  delete f.input.recipe.recovery
  expect(await executePluginEnvironmentRecovery(f.input)).toEqual({
    kind: 'refused',
    reason: 'unsupported-action'
  })
  expect(f.input.authorize).not.toHaveBeenCalled()
  await expect(access(f.marker)).rejects.toThrow()
  await expect(access(f.mutation)).rejects.toThrow()
})
