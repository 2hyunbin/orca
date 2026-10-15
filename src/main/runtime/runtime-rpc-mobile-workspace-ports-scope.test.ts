import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { DeviceRegistry } from './device-registry'
import { createMobileRpcSurfaceRuntime } from './runtime-rpc-mobile-method-allowlist-fixtures'

const scan = {
  executionHostId: 'local',
  platform: 'darwin',
  scannedAt: 1,
  ports: []
}

async function dispatchAsPhone(method: string, params: Record<string, unknown>) {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-ports-scope-'))
  const { runtime } = createMobileRpcSurfaceRuntime()
  const scanWorkspacePortsOnHost = vi.fn().mockResolvedValue(scan)
  const killWorkspacePortOnHost = vi.fn().mockResolvedValue({ ok: true })
  Object.assign(runtime, { scanWorkspacePortsOnHost, killWorkspacePortOnHost })
  const server = new OrcaRuntimeRpcServer({ runtime, userDataPath, enableWebSocket: false })
  server['deviceRegistry'] = new DeviceRegistry(userDataPath)
  const device = server['deviceRegistry']!.addDevice('phone', 'mobile')
  const replies: Record<string, unknown>[] = []
  await server['handleWebSocketMessage'](
    JSON.stringify({ id: 'req_1', method, deviceToken: device.token, params }),
    (response) => {
      replies.push(JSON.parse(response))
    },
    () => {}
  )
  return { reply: replies[0] ?? {}, scanWorkspacePortsOnHost, killWorkspacePortOnHost }
}

describe("a phone reading a workspace's ports", () => {
  it('scans the host the workspace runs on', async () => {
    const { reply, scanWorkspacePortsOnHost } = await dispatchAsPhone('workspacePorts.scanHost', {
      worktree: 'id:repo::/src/app'
    })

    expect(reply).toMatchObject({ ok: true, result: scan })
    expect(scanWorkspacePortsOnHost).toHaveBeenCalledWith('id:repo::/src/app')
  })

  it('cannot stop a listener', async () => {
    const { reply, killWorkspacePortOnHost } = await dispatchAsPhone('workspacePorts.killHost', {
      worktree: 'id:repo::/src/app',
      executionHostId: 'local',
      pid: 42,
      port: 3000
    })

    expect(reply).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(killWorkspacePortOnHost).not.toHaveBeenCalled()
  })
})
