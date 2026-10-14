import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { handleProviderRequest } from '../src/provider-client.mjs'

const request = {
  protocolVersion: 2,
  providerId: 'company.platform/environments',
  contextId: 'company/account/region',
  operationId: '11111111-1111-4111-8111-111111111111',
  action: 'list'
}
const environment = {
  ORCA_ENVIRONMENT_PROVIDER_URL: 'https://provider.example.invalid/api/',
  ORCA_ENVIRONMENT_PROVIDER_TOKEN: 'owned-test-token'
}
const inventory = { ...request, kind: 'inventory', resources: [] }

test('the shipped single bundle runs without installed dependencies or credentials', () => {
  const env = { ...process.env }
  delete env.ORCA_ENVIRONMENT_PROVIDER_URL
  delete env.ORCA_ENVIRONMENT_PROVIDER_TOKEN
  delete env.NODE_OPTIONS
  delete env.NODE_PATH
  delete env.ELECTRON_RUN_AS_NODE
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('../dist/provider.mjs', import.meta.url))],
    {
      env,
      input: JSON.stringify(request),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 1024 * 1024
    }
  )
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), {
    ...request,
    kind: 'error',
    code: 'authentication-required',
    message: 'Configure this control host’s company provider URL and credentials.'
  })
})

test('missing host credentials returns authentication-required without contacting a backend', async () => {
  const fetcher = () => {
    throw new Error('must not contact backend')
  }
  const result = await handleProviderRequest(request, {}, fetcher)
  assert.equal(result.kind, 'error')
  assert.equal(result.code, 'authentication-required')
  assert.equal(result.contextId, request.contextId)
})
test('forwards the exact account/action/operation and refuses redirects', async () => {
  let calls = 0
  const result = await handleProviderRequest(request, environment, async (url, options) => {
    calls += 1
    assert.equal(url.toString(), 'https://provider.example.invalid/api/operations')
    assert.equal(options.redirect, 'error')
    assert.equal(options.method, 'POST')
    assert.deepEqual(JSON.parse(options.body), request)
    assert.equal(options.headers.authorization, 'Bearer owned-test-token')
    return new Response(JSON.stringify(inventory))
  })
  assert.equal(calls, 1)
  assert.equal(result.kind, 'inventory')
})
test('a mutation failure makes one request and never leaks the backend body', async () => {
  let calls = 0
  await assert.rejects(
    handleProviderRequest(
      { ...request, action: 'create', parameters: {} },
      environment,
      async () => {
        calls += 1
        return new Response('SECRET_BACKEND_BODY', { status: 503 })
      }
    ),
    (error) => !error.message.includes('SECRET') && error.message.includes('confirm')
  )
  assert.equal(calls, 1)
})
test('rejects a response for another operation or backend account', async () => {
  for (const response of [
    { ...inventory, contextId: 'other/account' },
    { ...inventory, operationId: '22222222-2222-4222-8222-222222222222' }
  ]) {
    await assert.rejects(
      handleProviderRequest(
        request,
        environment,
        async () => new Response(JSON.stringify(response))
      )
    )
  }
})
test('bounds provider bytes and rejects malformed UTF-8', async () => {
  for (const body of ['x'.repeat(512 * 1024 + 1), new Uint8Array([0xff])]) {
    await assert.rejects(
      handleProviderRequest(request, environment, async () => new Response(body))
    )
  }
})
test('validates base URLs before sending account credentials', async () => {
  for (const url of [
    'http://provider.invalid/',
    'https://user:secret@provider.invalid/',
    'https://provider.invalid/?token=secret',
    'https://provider.invalid/#fragment'
  ]) {
    await assert.rejects(
      handleProviderRequest(request, { ...environment, ORCA_ENVIRONMENT_PROVIDER_URL: url }, () => {
        throw new Error('must not contact backend')
      }),
      /base URL/
    )
  }
})
test('uses separately correlated receipt queries without replaying the original mutation', async () => {
  const receiptRequest = {
    protocolVersion: 1,
    providerId: request.providerId,
    contextId: request.contextId,
    queryId: request.operationId,
    operation: {
      operationId: '22222222-2222-4222-8222-222222222222',
      requestDigest: 'a'.repeat(64),
      action: 'create'
    }
  }
  const result = await handleProviderRequest(receiptRequest, environment, async (url, options) => {
    assert.equal(url.pathname, '/api/receipts')
    assert.deepEqual(JSON.parse(options.body), receiptRequest)
    return new Response(JSON.stringify({ ...receiptRequest, kind: 'unknown' }))
  })
  assert.equal(result.kind, 'unknown')
})
