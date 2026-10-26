import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAutomationPrecheck } from './precheck-runner'

const sshManagerState = vi.hoisted(() => ({
  initialize: vi.fn(async () => {}),
  manager: null as null | {
    getConnection: ReturnType<typeof vi.fn>
  }
}))

vi.mock('../ssh/targets/ssh-target-registry', () => ({
  ensureSshConnectionManager: sshManagerState.initialize,
  getSshConnectionManager: () => sshManagerState.manager
}))

const node = JSON.stringify(process.execPath)

function nodeCommand(script: string): string {
  return `${node} -e ${JSON.stringify(script)}`
}

describe('runAutomationPrecheck', () => {
  let cwd = ''

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'orca-precheck-test-'))
    sshManagerState.manager = null
    sshManagerState.initialize.mockReset().mockResolvedValue(undefined)
  })

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  it('captures exit code and output for a non-zero local precheck', async () => {
    const result = await runAutomationPrecheck({
      precheck: {
        command: nodeCommand(
          "console.log('stdout text'); console.error('stderr text'); process.exit(7)"
        ),
        timeoutSeconds: 5
      },
      target: { type: 'local', cwd }
    })

    expect(result.exitCode).toBe(7)
    expect(result.timedOut).toBe(false)
    expect(result.stdout).toContain('stdout text')
    expect(result.stderr).toContain('stderr text')
    expect(result.error).toBeNull()
  })

  it('marks a local precheck as timed out', async () => {
    const result = await runAutomationPrecheck({
      precheck: {
        command: nodeCommand('setTimeout(() => {}, 5000)'),
        timeoutSeconds: 1
      },
      target: { type: 'local', cwd }
    })

    expect(result.exitCode).toBeNull()
    expect(result.timedOut).toBe(true)
    expect(result.error).toBe('Precheck timed out after 1s.')
  })

  it('initializes SSH before executing and uses the channel exit event as the exit code', async () => {
    const channel = Object.assign(new EventEmitter(), {
      stderr: new PassThrough(),
      close: vi.fn()
    })
    const manager = {
      getConnection: vi.fn(() => ({
        getState: () => ({ status: 'connected' }),
        exec: vi.fn(async () => channel)
      }))
    }
    sshManagerState.initialize.mockImplementationOnce(async () => {
      sshManagerState.manager = manager
    })

    const resultPromise = runAutomationPrecheck({
      precheck: {
        command: "printf 'ready'",
        timeoutSeconds: 5
      },
      target: {
        type: 'ssh',
        cwd: '/repo/path',
        connectionId: 'ssh-1'
      }
    })
    await vi.waitFor(() => expect(channel.listenerCount('close')).toBe(1))
    channel.emit('data', Buffer.from('ready\n'))
    channel.emit('exit', 0)
    channel.emit('close')

    const result = await resultPromise
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('ready')
    expect(result.error).toBeNull()
  })
})
