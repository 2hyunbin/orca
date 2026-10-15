import { z } from 'zod'
import { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnProcess } from '@orca/process-host'
import {
  forceTerminateProcessTree,
  signalProcessTree
} from '@orca/process-host/process-tree-termination'
import { probeOpenCodeLaunchModelContext } from './opencode-launch-model-context'
import { readFetchResponseJsonWithinLimit } from '../../shared/fetch-response-body'

vi.mock('@orca/process-host', () => ({ spawnProcess: vi.fn() }))
vi.mock('@orca/process-host/process-tree-termination', () => ({
  signalProcessTree: vi.fn(),
  forceTerminateProcessTree: vi.fn()
}))

vi.mock('../../shared/fetch-response-body', () => ({ readFetchResponseJsonWithinLimit: vi.fn() }))

class ProbeChild extends ChildProcess {
  override stdin = new PassThrough()
  override stdout = new PassThrough()
  override stderr = new PassThrough()
  override pid = 123456
  override exitCode: number | null = null
  override signalCode: NodeJS.Signals | null = null
  // A handle-less ChildProcess's own kill can signal this test's process group.
  override kill = vi.fn((_signal?: NodeJS.Signals | number): boolean => true)
  override stdio: [PassThrough, PassThrough, PassThrough, undefined, undefined] = [
    this.stdin,
    this.stdout,
    this.stderr,
    undefined,
    undefined
  ]
}

const directory = '/private/project'
const model = { id: 'model-b', providerID: 'private-proof', enabled: true }
const snapshot = {
  model: { location: { directory }, data: [model] },
  agent: {
    location: { directory },
    data: [{ id: 'build', mode: 'primary', hidden: false, model }]
  },
  'model/default': { location: { directory }, data: model },
  config: [{ type: 'document', info: { default_agent: 'build' } }]
}
const platform = Object.getOwnPropertyDescriptor(process, 'platform')
let child: ProbeChild
let closeDuringFetch = false
function close() {
  child.exitCode = 0
  child.emit('exit', 0, null)
  child.emit('close', 0, null)
}
const options = { executable: '/private/opencode', cwd: directory, env: {} }

describe('OpenCode model probe termination evidence', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    // The POSIX group stop runs against real processes in the supervision suite.
    Object.defineProperty(process, 'platform', { value: 'win32' })
    vi.mocked(readFetchResponseJsonWithinLimit).mockImplementation((response) => response.json())
    child = new ProbeChild()
    closeDuringFetch = false
    vi.mocked(spawnProcess).mockImplementation(() => {
      queueMicrotask(() => child.stdout.write('server listening on http://127.0.0.1:45678\n'))
      return child
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL) => {
        const endpoint = z
          .enum(['model', 'agent', 'model/default', 'config'])
          .parse(input.pathname.slice('/api/'.length))
        const response = snapshot[endpoint]
        if (closeDuringFetch && endpoint === 'config') {
          queueMicrotask(close)
        }
        return new Response(JSON.stringify(response), { status: 200 })
      })
    )
    vi.mocked(signalProcessTree).mockImplementation(async () => {
      close()
      return true
    })
    vi.mocked(forceTerminateProcessTree).mockResolvedValue(false)
  })

  afterEach(() => {
    vi.useRealTimers()
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
    vi.unstubAllGlobals()
  })

  it('cancels all unread responses if the bounded body reader fails', async () => {
    const cancel = vi.fn()
    vi.mocked(readFetchResponseJsonWithinLimit).mockRejectedValue(new Error('body_reader_failed'))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new ReadableStream({ cancel }), { status: 200 }))
    )
    expect(await probeOpenCodeLaunchModelContext(options)).toBeNull()
    expect(cancel).toHaveBeenCalledTimes(4)
    expect(signalProcessTree).toHaveBeenCalledWith(child, 'SIGTERM')
  })

  it('accepts an already-closed Windows probe without signaling its former pid', async () => {
    closeDuringFetch = true
    vi.mocked(signalProcessTree).mockResolvedValue(false)
    expect(await probeOpenCodeLaunchModelContext(options)).toMatchObject({ primaryAgent: 'build' })
    expect(signalProcessTree).not.toHaveBeenCalled()
    expect(forceTerminateProcessTree).not.toHaveBeenCalled()
  })

  it('keeps a Windows root exit with inherited pipes unverified and avoids its former pid', async () => {
    vi.mocked(signalProcessTree).mockImplementation(async () => {
      child.exitCode = 0
      child.emit('exit', 0, null)
      return false
    })
    expect(await probeOpenCodeLaunchModelContext(options)).toBeNull()
    expect(forceTerminateProcessTree).not.toHaveBeenCalled()
  })

  it('requires verified termination when a still-live Windows probe does not close', async () => {
    vi.mocked(signalProcessTree).mockResolvedValue(true)
    expect(await probeOpenCodeLaunchModelContext(options)).toBeNull()
    expect(forceTerminateProcessTree).toHaveBeenCalledOnce()
  })
})
