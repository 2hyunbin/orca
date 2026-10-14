import { describe, expect, it } from 'vitest'
import {
  MANAGED_RUNTIME_GATEWAY_CAPABILITY,
  ManagedRuntimeGatewayDescriptorSchema,
  managedRuntimeGatewayEndpoint,
  managedRuntimeGatewayPath,
  parseManagedRuntimeGatewayRoute
} from './managed-runtime-gateway-contract'

const descriptor = {
  version: 1 as const,
  controllerRuntimeId: 'controller-runtime',
  environmentId: 'managed-env',
  runtimeId: 'child-runtime',
  sshTargetId: 'provider-target',
  targetGeneration: 2,
  name: 'Company devbox'
}

describe('managed runtime gateway identity', () => {
  it('keeps controller, managed runtime, target and generation distinct', () => {
    expect(ManagedRuntimeGatewayDescriptorSchema.parse(descriptor)).toEqual(descriptor)
    expect(() =>
      ManagedRuntimeGatewayDescriptorSchema.parse({ ...descriptor, deviceToken: 'secret' })
    ).toThrow()
  })
  it('requires negotiated support before constructing a child endpoint', () => {
    expect(() => managedRuntimeGatewayEndpoint('wss://controller.example', descriptor, [])).toThrow(
      'does not support'
    )
    expect(
      managedRuntimeGatewayEndpoint('wss://controller.example', descriptor, [
        MANAGED_RUNTIME_GATEWAY_CAPABILITY
      ])
    ).toBe('wss://controller.example/_orca/managed/managed-env/2')
  })
  it.each([
    'https://controller.example',
    'ws://user:secret@controller.example',
    'ws://controller.example/custom',
    'ws://controller.example/?token=secret',
    'ws://controller.example/#fragment'
  ])('refuses an ambiguous controller endpoint %s', (endpoint) => {
    expect(() =>
      managedRuntimeGatewayEndpoint(endpoint, descriptor, [MANAGED_RUNTIME_GATEWAY_CAPABILITY])
    ).toThrow()
  })
  it.each(['.', '..', ' env', 'env\n'])(
    'refuses an unsafe environment identity %s',
    (environmentId) => {
      expect(() => managedRuntimeGatewayPath(environmentId, 2)).toThrow()
    }
  )
  it('round-trips an encoded identity without interpreting its separators', () => {
    const path = managedRuntimeGatewayPath('env/with spaces', 2)
    expect(parseManagedRuntimeGatewayRoute(path)).toEqual({
      kind: 'managed',
      environmentId: 'env/with spaces',
      targetGeneration: 2
    })
  })
  it.each([
    '/_orca/managed/env/0',
    '/_orca/managed/env/02',
    '/_orca/managed/env/2?extra=1',
    '/_orca/managed/env/9007199254740992',
    '/_orca/managed/%2e%2e/2',
    '/_orca/managed/env/2/extra',
    '/_orca/managed/%zz/2',
    '/%5forca/managed/%zz/2',
    '/_orca/managed',
    '/_orca/managed?extra=1',
    '/_orca\\managed\\env\\2',
    '/%5forca/managed/env/2',
    '/_ORCA/managed/env/2'
  ])('rejects a reserved route variant %s', (path) => {
    expect(parseManagedRuntimeGatewayRoute(path)).toEqual({ kind: 'invalid' })
  })
  it.each(['/', '/legacy?web-client=1', undefined])(
    'preserves unrelated transport paths %s',
    (path) => {
      expect(parseManagedRuntimeGatewayRoute(path)).toEqual({ kind: 'root' })
    }
  )
})
