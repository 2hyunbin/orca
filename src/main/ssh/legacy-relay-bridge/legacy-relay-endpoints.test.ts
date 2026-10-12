import { describe, expect, it } from 'vitest'
import {
  legacyRelayEndpointListCommand,
  posixLegacyRelayConnectCommand
} from './legacy-relay-endpoints'

describe('legacy relay endpoints', () => {
  it('runs the relay’s own --connect from its version directory, never a launch', () => {
    const command = posixLegacyRelayConnectCommand(
      '/home/me',
      '/usr/bin/node',
      '/home/me/.orca-remote/relay-0.1.0+abc/relay-1234.sock'
    )
    expect(command).toBe(
      "cd '/home/me/.orca-remote/relay-0.1.0+abc' && '/usr/bin/node' relay.js --connect " +
        "--sock-path '/home/me/.orca-remote/relay-0.1.0+abc/relay-1234.sock' " +
        "--credential-file '/home/me/.orca-remote/relay-0.1.0+abc/relay-1234.sock.credential'"
    )
    expect(command).not.toContain('--detached')
  })

  it('reaches a socket a long $HOME moved under /tmp through its home version directory', () => {
    expect(
      posixLegacyRelayConnectCommand(
        '/home/a-very-long-name',
        'node',
        '/tmp/.orca-relay-1000/relay-0.1.0+abc/relay-1234.sock'
      )
    ).toBe(
      "cd '/home/a-very-long-name/.orca-remote/relay-0.1.0+abc' && 'node' relay.js --connect " +
        "--sock-path '/tmp/.orca-relay-1000/relay-0.1.0+abc/relay-1234.sock' " +
        "--credential-file '/home/a-very-long-name/.orca-remote/relay-0.1.0+abc/relay-1234.sock.credential'"
    )
  })

  it('names no build for a socket outside a version directory', () => {
    expect(posixLegacyRelayConnectCommand('/home/me', 'node', '/tmp/relay.sock')).toBeNull()
  })

  it('lists only this target’s sockets, read-only', () => {
    const command = legacyRelayEndpointListCommand('/home/me', 'relay-1234.sock')
    expect(command).toContain('"$base"/relay-*/\'relay-1234.sock\'')
    expect(command).toContain('"$short_base"/relay-*/\'relay-1234.sock\'')
    expect(command).not.toMatch(/\brm\b|\bkill\b|--detached/)
  })
})
