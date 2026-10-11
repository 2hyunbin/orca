import './mock-descendant-sweep'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, uptime } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DaemonClient } from './client'
import { createMockSubprocess } from './daemon-pty-adapter-test-harness'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonServer } from './daemon-server'
import { getDaemonSocketPath } from './daemon-spawner'

describe('daemon automatic-work resume', () => {
  let directory: string | undefined
  let server: DaemonServer | undefined
  let client: DaemonClient | undefined

  afterEach(async () => {
    client?.disconnect()
    await server?.shutdown()
    if (directory) {
      rmSync(directory, { recursive: true, force: true })
    }
    vi.restoreAllMocks()
  })

  it('clears a same-boot crash pause the daemon carried over, on request', async () => {
    directory = mkdtempSync(join(tmpdir(), 'daemon-automatic-work-resume-'))
    const markerPath = join(directory, 'daemon.automatic-work-run.json')
    // The previous daemon died with automatic work running in this boot.
    writeFileSync(
      markerPath,
      JSON.stringify({
        schemaVersion: 1,
        boot: {
          bootTimeMs: process.platform === 'win32' ? null : Date.now() - uptime() * 1000,
          bootId: null
        },
        state: 'running',
        mode: { kind: 'normal' }
      })
    )
    server = new DaemonServer({
      socketPath: getDaemonSocketPath(directory),
      tokenPath: join(directory, 'daemon.token'),
      automaticWorkMarkerPath: markerPath,
      spawnAdmission: 'enforce',
      spawnSubprocess: async () => createMockSubprocess()
    })
    await server.start()
    client = new DaemonClient({
      socketPath: getDaemonSocketPath(directory),
      tokenPath: join(directory, 'daemon.token')
    })
    await client.ensureConnected()

    const before = await client.request<{ mode: { kind: string } }>(
      'automaticWorkStatus',
      undefined
    )
    const resumed = await client.request<Record<string, unknown>>('resumeAutomaticWork', undefined)
    const after = await client.request<{ mode: { kind: string } }>('automaticWorkStatus', undefined)

    // Windows cannot tell a new boot from the same one, so it never pauses (Fast Startup).
    if (process.platform === 'win32') {
      expect(before.mode).toEqual({ kind: 'normal' })
      expect(resumed).toMatchObject({ cleared: null })
    } else {
      expect(before.mode).toMatchObject({ kind: 'paused', reason: 'unclean_host_death' })
      expect(resumed).toMatchObject({
        admission: 'enforce',
        mode: { kind: 'normal' },
        cleared: { kind: 'paused', reason: 'unclean_host_death' }
      })
    }
    expect(after.mode).toEqual({ kind: 'normal' })
  })

  it('reports no gate for a daemon that predates the request', async () => {
    vi.spyOn(DaemonClient.prototype, 'ensureConnected').mockResolvedValue()
    vi.spyOn(DaemonClient.prototype, 'request').mockRejectedValue(
      new Error('Unknown request type: resumeAutomaticWork')
    )
    const adapter = new DaemonPtyAdapter({
      socketPath: '/tmp/orca-automatic-work-old.sock',
      tokenPath: '/tmp/orca-automatic-work-old.token'
    })
    try {
      await expect(adapter.resumeAutomaticWork()).resolves.toBeNull()
      await expect(adapter.getAutomaticWorkStatus()).resolves.toBeNull()
    } finally {
      adapter.dispose()
    }
  })

  it('does not hide a real failure behind "no gate"', async () => {
    vi.spyOn(DaemonClient.prototype, 'ensureConnected').mockResolvedValue()
    vi.spyOn(DaemonClient.prototype, 'request').mockRejectedValue(new Error('socket closed'))
    const adapter = new DaemonPtyAdapter({
      socketPath: '/tmp/orca-automatic-work-broken.sock',
      tokenPath: '/tmp/orca-automatic-work-broken.token'
    })
    try {
      await expect(adapter.resumeAutomaticWork()).rejects.toThrow('socket closed')
    } finally {
      adapter.dispose()
    }
  })
})
