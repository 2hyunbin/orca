import './mock-descendant-sweep'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DaemonClient } from './client'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonServer } from './daemon-server'
import { getDaemonSocketPath } from './daemon-spawner'
import { createMockSubprocess } from './daemon-pty-adapter-test-harness'
import { HostTerminalPolicy } from './host-terminal-policy'
import { SystemPtyLimit } from './system-pty-limit'
import type { TerminalLimitStatus } from '../../shared/terminal-limit-policy'

let server: DaemonServer | undefined
let client: DaemonClient | undefined
let directory: string | undefined
afterEach(async () => {
  client?.disconnect()
  await server?.shutdown()
  if (directory) {
    rmSync(directory, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

it('reads and saves on the attached daemon socket, refusing stale identity and lost endpoint writes', async () => {
  directory = mkdtempSync(join(tmpdir(), 'terminal-limit-rpc-'))
  const path = join(directory, 'policy', 'terminals.json')
  server = new DaemonServer({
    socketPath: getDaemonSocketPath(directory),
    tokenPath: join(directory, 'token'),
    terminalLimitPolicy: new HostTerminalPolicy(path, {}, new SystemPtyLimit(async () => 511)),
    spawnSubprocess: async () => createMockSubprocess()
  })
  await server.start()
  client = new DaemonClient({
    socketPath: getDaemonSocketPath(directory),
    tokenPath: join(directory, 'token')
  })
  await client.ensureConnected()
  const before = await client.request<TerminalLimitStatus>('terminalLimitStatus', undefined)
  expect(before).toMatchObject({
    maxTerminals: 256,
    systemPtyLimit: 511,
    source: 'default',
    editable: true
  })
  const update = { daemonNonce: before.daemonNonce, maxTerminals: 384 }
  await expect(client.request('setTerminalLimit', update)).resolves.toMatchObject({
    maxTerminals: 384,
    source: 'saved'
  })
  const saved = readFileSync(path, 'utf8')
  await expect(
    client.request('setTerminalLimit', { ...update, maxTerminals: 512 })
  ).rejects.toThrow('capacity')
  await expect(
    client.request('setTerminalLimit', { ...update, daemonNonce: 'other-daemon', maxTerminals: 20 })
  ).rejects.toThrow('changed')
  vi.spyOn(server['endpoint'], 'hasLostOwnership').mockReturnValue(true)
  await expect(client.request('setTerminalLimit', { ...update, maxTerminals: 20 })).rejects.toThrow(
    'host changed'
  )
  expect(readFileSync(path, 'utf8')).toBe(saved)
})

it('recognizes an older daemon without replacement and preserves real transport failures', async () => {
  vi.spyOn(DaemonClient.prototype, 'ensureConnected').mockResolvedValue()
  const request = vi
    .spyOn(DaemonClient.prototype, 'request')
    .mockRejectedValue(new Error('Unknown request type: terminalLimitStatus'))
  const adapter = new DaemonPtyAdapter({
    socketPath: '/tmp/orca-limit-old.sock',
    tokenPath: '/tmp/orca-limit-old.token'
  })
  try {
    await expect(adapter.terminalLimit()).resolves.toBeNull()
    request.mockRejectedValue(new Error('socket closed'))
    await expect(adapter.terminalLimit()).rejects.toThrow('socket closed')
  } finally {
    adapter.dispose()
  }
})
