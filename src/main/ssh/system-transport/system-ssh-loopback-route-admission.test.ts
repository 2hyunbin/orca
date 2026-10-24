import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { SshTarget } from '../../../shared/ssh-types'
import type { SshResolvedConfig } from '../config/ssh-g-config-resolution'
import {
  admitSystemSshLoopbackRoute,
  agentListingMayHoldSecurityKey
} from './system-ssh-loopback-route-admission'
import { findSystemSsh } from './system-ssh-binary'

const target: SshTarget = {
  id: 'target-1',
  label: 'Dev box',
  host: 'devbox',
  configHost: 'devbox',
  port: 22,
  username: '',
  source: 'ssh-config'
}
// Why an empty identity list: the security-key check must not read this machine's ~/.ssh.
const resolved: SshResolvedConfig = {
  hostname: 'devbox.internal',
  port: 22,
  identityFile: [],
  identitiesOnly: false,
  forwardAgent: false,
  proxyJump: 'bastion',
  proxyUseFdpass: false,
  controlMaster: 'no',
  controlPersist: 'no',
  userKnownHostsFiles: [],
  globalKnownHostsFiles: [],
  strictHostKeyChecking: 'ask',
  hashKnownHosts: false,
  updateHostKeys: 'no'
}
const route = { localPort: 1, hostKeyAlias: 'devbox.internal' }

// Real OpenSSH: the drift is in how ssh_config matches, which only OpenSSH can answer.
describe.skipIf(findSystemSsh() === null)('admitSystemSshLoopbackRoute with real ssh -G', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-loopback-admission-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  function writeConfig(name: string, body: string): string {
    const path = join(dir, name)
    writeFileSync(path, body)
    return path
  }

  it('refuses a route under which a `Match host` block would log in as another user', async () => {
    const configFile = writeConfig(
      'match-host',
      [
        'Host devbox',
        '  HostName devbox.internal',
        '  ProxyJump bastion',
        '  IdentityAgent none',
        'Match host devbox.internal',
        '  User route_user',
        ''
      ].join('\n')
    )

    await expect(
      admitSystemSshLoopbackRoute(target, resolved, { configFile }, route)
    ).resolves.toEqual({ admitted: false, reason: 'route changes user' })
  })

  it('admits a route that changes only how the host is reached', async () => {
    const configFile = writeConfig(
      'plain',
      [
        'Host devbox',
        '  HostName devbox.internal',
        '  User route_user',
        '  ProxyJump bastion',
        '  IdentityAgent none',
        ''
      ].join('\n')
    )

    await expect(
      admitSystemSshLoopbackRoute(target, resolved, { configFile }, route)
    ).resolves.toEqual({ admitted: true })
  })
})

describe('agentListingMayHoldSecurityKey', () => {
  const listing = (code: number | null, stdout = '', timedOut = false) => ({
    code,
    stdout,
    timedOut
  })

  it.each([
    ['an sk- key in the agent', listing(0, 'sk-ssh-ed25519@openssh.com AAAA k\n'), false, true],
    ['only ordinary agent keys', listing(0, 'ssh-ed25519 AAAA k\n'), false, false],
    ['an agent with no identities', listing(1), false, false],
    ['no default agent to sign with', listing(2), false, false],
    ['an unreachable configured IdentityAgent', listing(2), true, true],
    ['an agent query that timed out', listing(null, '', true), false, true]
  ])('%s → %s', (_name, result, agentConfigured, expected) => {
    expect(agentListingMayHoldSecurityKey(result, agentConfigured)).toBe(expected)
  })
})
