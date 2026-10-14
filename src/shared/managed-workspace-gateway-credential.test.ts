import { describe, expect, it } from 'vitest'
import {
  managedWorkspaceGatewayCredential,
  parseManagedWorkspaceGatewayCredential
} from './managed-workspace-gateway-credential'

describe('managed workspace credential audience', () => {
  it('preserves an encoded child identity while withholding an ordinary root bearer', () => {
    const credential = managedWorkspaceGatewayCredential('parent-secret', 'child with space', 7)
    expect(credential).not.toBe('parent-secret')
    expect(parseManagedWorkspaceGatewayCredential(credential)).toEqual({
      parentToken: 'parent-secret',
      environmentId: 'child with space',
      targetGeneration: 7
    })
    expect(parseManagedWorkspaceGatewayCredential('parent-secret')).toBeNull()
  })

  it.each([
    { route: '/', parentToken: 'secret' },
    { route: '/_orca/managed/child/01', parentToken: 'secret' },
    { route: '/_orca/managed/child/1?root=true', parentToken: 'secret' },
    { route: '/_orca/managed/child/1', parentToken: '' },
    { route: '/_orca/managed/child/1', parentToken: 'secret', extra: true }
  ])('refuses malformed or ambiguous audiences: %j', (payload) => {
    const credential = `orca-gateway-v1:${Buffer.from(JSON.stringify(payload)).toString('base64url')}`
    expect(parseManagedWorkspaceGatewayCredential(credential)).toBeNull()
  })

  it('refuses padded, invalid and oversized encodings', () => {
    const credential = managedWorkspaceGatewayCredential('secret', 'child', 1)
    for (const value of [
      `${credential}=`,
      'orca-gateway-v1:!',
      `orca-gateway-v1:${'a'.repeat(2048)}`
    ]) {
      expect(parseManagedWorkspaceGatewayCredential(value)).toBeNull()
    }
  })
})
