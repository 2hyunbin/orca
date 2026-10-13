import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SshTarget } from '../../shared/ssh-types'
import {
  admitEnvironmentProviderSshTarget,
  setEnvironmentProviderSshAuthorizer
} from './environment-provider-ssh-admission'

const target: SshTarget = {
  id: 'provider-ssh-test',
  label: 'Development machine',
  host: 'box.internal',
  port: 22,
  username: 'developer',
  environmentProvider: {
    version: 1,
    binding: {
      executionHostId: 'local',
      providerId: 'company.platform/pods',
      contextId: 'company/account',
      sourceDigest: 'a'.repeat(64),
      recipeDigest: 'b'.repeat(64)
    },
    resourceId: 'pod-one',
    resourceRevision: 'r1',
    connection: {
      type: 'ssh',
      host: 'box.internal',
      port: 22,
      username: 'developer',
      projectRoot: '/projects'
    }
  }
}
afterEach(() => setEnvironmentProviderSshAuthorizer(null))
describe('provider SSH admission cannot lose its owner fence', () => {
  it('leaves ordinary targets on their existing path but refuses provider targets without host support', async () => {
    const { environmentProvider: _owner, ...ordinary } = target
    expect(await admitEnvironmentProviderSshTarget(ordinary)).toBeNull()
    await expect(admitEnvironmentProviderSshTarget(target)).rejects.toThrow('unavailable')
  })
  it('rejects a malformed binding before a callback can authorize it', async () => {
    const authorize = vi.fn(async () => ({
      isCurrent: () => true,
      signal: new AbortController().signal
    }))
    setEnvironmentProviderSshAuthorizer(authorize)
    await expect(
      admitEnvironmentProviderSshTarget({
        ...target,
        environmentProvider: { ...target.environmentProvider!, resourceRevision: '' }
      })
    ).rejects.toThrow()
    expect(authorize).not.toHaveBeenCalled()
  })
  it('snapshots the target and refuses a withdrawn or superseded authorizer', async () => {
    const held = Promise.withResolvers<void>()
    const seen: SshTarget[] = []
    setEnvironmentProviderSshAuthorizer(async (t) => {
      seen.push(t)
      await held.promise
      return { isCurrent: () => true, signal: new AbortController().signal }
    })
    const original = structuredClone(target)
    const pending = admitEnvironmentProviderSshTarget(original)
    original.host = 'changed.internal'
    setEnvironmentProviderSshAuthorizer(null)
    held.resolve()
    await expect(pending).rejects.toThrow('authorization changed')
    expect(seen[0]?.host).toBe('box.internal')
  })
  it.each([true, false])('accepts only an unrevoked current lease: %s', async (current) => {
    const controller = new AbortController()
    setEnvironmentProviderSshAuthorizer(async () => ({
      isCurrent: () => current,
      signal: controller.signal
    }))
    if (current) {
      expect(await admitEnvironmentProviderSshTarget(target)).toMatchObject({
        signal: controller.signal
      })
    } else {
      await expect(admitEnvironmentProviderSshTarget(target)).rejects.toThrow(
        'authorization changed'
      )
    }
    controller.abort()
    await expect(admitEnvironmentProviderSshTarget(target)).rejects.toThrow('authorization changed')
  })
})
