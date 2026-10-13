import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  environmentRecipeRecoveryRequestSchema,
  parseEnvironmentRecipeRecoveryResponse
} from './environment-recipe-recovery-protocol'
const request = environmentRecipeRecoveryRequestSchema.parse({
  protocolVersion: 1,
  queryId: randomUUID(),
  providerId: 'company.platform/pods',
  contextId: 'company/account',
  operation: {
    operationId: randomUUID(),
    requestDigest: 'a'.repeat(64),
    action: 'sleep',
    resourceId: 'devbox',
    expectedRevision: 'r1'
  }
})
const resource = {
  id: 'devbox',
  name: 'Devbox',
  revision: 'r2',
  lifetime: 'long-lived',
  state: 'sleeping'
}
function receipt(overrides = {}) {
  return JSON.stringify({
    ...request,
    kind: 'receipt',
    outcome: { kind: 'completed', resource },
    ...overrides
  })
}
describe('authoritative environment operation receipts', () => {
  it('pins the original digest, namespace and requested transition while allowing separately observed current state', () => {
    const currentResource = { ...resource, state: 'running', revision: 'r3' }
    expect(
      parseEnvironmentRecipeRecoveryResponse(receipt({ currentResource }), request)
    ).toMatchObject({
      kind: 'receipt',
      outcome: { resource: { state: 'sleeping' } },
      currentResource: { state: 'running', revision: 'r3' }
    })
  })
  it.each([
    { contextId: 'other-account' },
    { providerId: 'other.platform/pods' },
    { queryId: randomUUID() },
    { operation: { ...request.operation, requestDigest: 'b'.repeat(64) } },
    { operation: { ...request.operation, operationId: randomUUID() } },
    { outcome: { kind: 'completed', resource: { ...resource, state: 'deleted' } } },
    { currentResource: { ...resource, id: 'other-machine' } }
  ])('refuses mismatched or contradictory receipts: %j', (changed) => {
    expect(() => parseEnvironmentRecipeRecoveryResponse(receipt(changed), request)).toThrow()
  })
  it('keeps unknown/pending separate from a terminal refusal and rejects unbounded or secret-bearing payloads', () => {
    for (const kind of ['pending', 'unknown']) {
      expect(
        parseEnvironmentRecipeRecoveryResponse(JSON.stringify({ ...request, kind }), request).kind
      ).toBe(kind)
    }
    expect(() =>
      parseEnvironmentRecipeRecoveryResponse(receipt({ credentials: { token: 'SECRET' } }), request)
    ).toThrow()
    expect(() =>
      parseEnvironmentRecipeRecoveryResponse(' '.repeat(512 * 1024 + 1), request)
    ).toThrow('limit')
  })
  it('does not allow a client to supply old creation parameters or a list operation to recovery', () => {
    expect(() =>
      environmentRecipeRecoveryRequestSchema.parse({
        ...request,
        operation: { ...request.operation, action: 'create', parameters: { token: 'SECRET' } }
      })
    ).toThrow()
    expect(() =>
      environmentRecipeRecoveryRequestSchema.parse({
        ...request,
        operation: { ...request.operation, action: 'list' }
      })
    ).toThrow()
  })
})
