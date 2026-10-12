import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import { z } from 'zod'
import {
  generateKeyPair,
  deriveSharedKey,
  publicKeyFromBase64,
  publicKeyToBase64,
  encrypt,
  decrypt
} from '../../shared/e2ee-crypto'
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import { getPreferredPairedRuntimeConnection } from '../../shared/runtime-environments'
import { getRemoteRuntimeRequestAdmissionEvidence } from '../../shared/remote-runtime-prepared-request-admission'
import {
  applyRuntimeEnvironmentCapabilityVerdict,
  captureRuntimeEnvironmentCapabilityEvidence,
  resetRuntimeEnvironmentCapabilityEvidence
} from './runtime-environment-capability-evidence'

const state = vi.hoisted(
  (): { environment: KnownRuntimeEnvironment | null; shared: ReturnType<typeof vi.fn> } => ({
    environment: null,
    shared: vi.fn()
  })
)
vi.mock('../../shared/runtime-environment-store', () => ({
  resolveEnvironment: () => state.environment,
  markEnvironmentUsed: vi.fn()
}))
vi.mock('./runtime-environment-managed-tunnel', () => ({
  resolveManagedRuntimeEnvironment: async () => state.environment
}))
vi.mock('./runtime-environment-call-queue', () => ({
  enqueueRuntimeCall: (_id: string, _method: string, run: () => unknown) => run()
}))
vi.mock('./runtime-environment-request-connections', () => ({
  sendRemoteRuntimeSharedControlRequest: state.shared,
  sendRemoteRuntimeConnectionRequest: vi.fn(),
  getRuntimeEnvironmentStatusOwner: vi.fn(),
  resetRuntimeEnvironmentStatusOwners: vi.fn()
}))
import { callRuntimeEnvironment } from './runtime-environment-transport-routing'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0)) {
    await cleanup()
  }
  expect(getRemoteRuntimeRequestAdmissionEvidence()).toEqual({
    pendingRequestCount: 0,
    retainedBytes: 0
  })
})

async function fixture(verdict: 'capable' | 'absent', runtimeId = 'original') {
  resetRuntimeEnvironmentCapabilityEvidence()
  state.shared.mockReset()
  const key = generateKeyPair()
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  if (typeof address !== 'object' || !address) {
    throw new Error('Missing server address')
  }
  const environment: KnownRuntimeEnvironment = {
    id: 'paired',
    name: 'Paired',
    createdAt: 1,
    updatedAt: 1,
    pairingRevision: 10,
    lastUsedAt: null,
    runtimeId: 'original',
    preferredEndpointId: 'ws',
    endpoints: [
      {
        id: 'ws',
        kind: 'websocket',
        label: 'WebSocket',
        endpoint: `ws://127.0.0.1:${address.port}`,
        deviceToken: 'test-token',
        publicKeyB64: publicKeyToBase64(key.publicKey)
      }
    ]
  }
  state.environment = environment
  const publish = (owner: string) =>
    applyRuntimeEnvironmentCapabilityVerdict({
      evidence: captureRuntimeEnvironmentCapabilityEvidence(
        environment.id,
        getPreferredPairedRuntimeConnection(environment)
      ),
      verdict,
      runtimeId: owner
    })
  publish('original')
  const calls: { socket: number; method: string }[] = []
  let socketCount = 0
  let helloReceived = false
  let releaseReady = () => {}
  let releaseStatus = () => {}
  let sendKeepalive = () => {}
  let closeSocket = () => {}
  let holdStatus = false
  let holdClose = false
  const reply = (ws: WebSocket, secret: Uint8Array, id: string, result: unknown) =>
    ws.send(encrypt(JSON.stringify({ id, ok: true, result, _meta: { runtimeId } }), secret))
  server.on('connection', (ws) => {
    const socket = ++socketCount
    let secret: Uint8Array | null = null
    let authenticated = false
    closeSocket = () => ws.close()
    ws.on('message', (data) => {
      if (!secret) {
        const hello = z.object({ publicKeyB64: z.string() }).parse(JSON.parse(data.toString()))
        secret = deriveSharedKey(key.secretKey, publicKeyFromBase64(hello.publicKeyB64))
        releaseReady = () => ws.send(JSON.stringify({ type: 'e2ee_ready' }))
        helloReceived = true
        return
      }
      const plaintext = decrypt(data.toString(), secret)
      if (plaintext === null) {
        throw new Error('Undecryptable test request')
      }
      if (!authenticated) {
        authenticated = true
        ws.send(encrypt(JSON.stringify({ type: 'e2ee_authenticated' }), secret))
        return
      }
      const request = z.object({ id: z.string(), method: z.string() }).parse(JSON.parse(plaintext))
      calls.push({ socket, method: request.method })
      const sharedKey = secret
      sendKeepalive = () => ws.send(encrypt(JSON.stringify({ _keepalive: true }), sharedKey))
      if (request.method === 'status.get') {
        releaseStatus = () => reply(ws, sharedKey, request.id, {})
        if (!holdStatus) {
          releaseStatus()
        }
      } else if (!holdClose) {
        reply(ws, sharedKey, request.id, { closed: true })
      }
    })
  })
  cleanups.push(async () => {
    for (const ws of server.clients) {
      ws.terminate()
    }
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const close = (timeoutMs = 3000, signal?: AbortSignal, method = 'session.tabs.close') =>
    callRuntimeEnvironment(
      '/test',
      environment.id,
      method,
      { tabId: 'agent-session:starting', reason: 'user' },
      timeoutMs,
      10,
      undefined,
      { expectedEnvironmentRuntimeId: 'original', signal }
    )
  return {
    calls,
    close,
    publish,
    environment,
    ready: async (beforeRelease?: () => void) => {
      await vi.waitFor(() => expect(socketCount).toBe(1))
      await vi.waitFor(() => expect(helloReceived).toBe(true))
      beforeRelease?.()
      releaseReady()
    },
    status: async () => {
      await vi.waitFor(() => expect(calls.map((c) => c.method)).toEqual(['status.get']))
    },
    releaseStatus: () => releaseStatus(),
    keepalive: () => sendKeepalive(),
    disconnect: () => closeSocket(),
    holdStatus: () => {
      holdStatus = true
    },
    holdClose: () => {
      holdClose = true
    }
  }
}

describe('runtime-pinned close at the encrypted send boundary', () => {
  it.each(['capable', 'absent'] as const)(
    'closes once on the socket that proved the unchanged runtime (%s)',
    async (verdict) => {
      const f = await fixture(verdict)
      const pending = f.close()
      await f.ready()
      await expect(pending).resolves.toMatchObject({ ok: true })
      expect(f.calls).toEqual([
        { socket: 1, method: 'status.get' },
        { socket: 1, method: 'session.tabs.close' }
      ])
      expect(state.shared).not.toHaveBeenCalled()
    }
  )

  it.each(['capable', 'absent'] as const)(
    'refuses an entirely unobserved replacement on a fresh socket (%s)',
    async (verdict) => {
      const f = await fixture(verdict, 'replacement')
      const pending = f.close()
      await f.ready()
      await expect(pending).resolves.toMatchObject({
        ok: false,
        error: { code: 'runtime_environment_changed' }
      })
      expect(f.calls).toEqual([{ socket: 1, method: 'status.get' }])
      expect(state.environment?.runtimeId).toBe('original')
    }
  )

  it.each(['saved', 'evidence', 'pairing'] as const)(
    'refuses a locally observed %s change during readiness',
    async (change) => {
      const f = await fixture('capable')
      const pending = f.close()
      await f.ready(() => {
        if (change === 'evidence') {
          f.publish('replacement')
        } else {
          state.environment = {
            ...f.environment,
            ...(change === 'saved' ? { runtimeId: 'replacement' } : { pairingRevision: 11 })
          }
        }
      })
      await expect(pending).resolves.toMatchObject({
        ok: false,
        error: { code: 'runtime_environment_changed' }
      })
      expect(f.calls.every((c) => c.method === 'status.get')).toBe(true)
    }
  )

  it('rechecks pairing when a held authenticated status reply arrives', async () => {
    const f = await fixture('absent')
    f.holdStatus()
    const pending = f.close()
    await f.ready()
    await f.status()
    state.environment = { ...f.environment, pairingRevision: 11 }
    f.releaseStatus()
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: 'runtime_environment_changed' }
    })
    expect(f.calls).toHaveLength(1)
  })

  it('does not reconnect or dispatch close after the proving socket disconnects', async () => {
    const f = await fixture('capable')
    f.holdStatus()
    const pending = f.close().catch((error) => error)
    await f.ready()
    await f.status()
    f.disconnect()
    await expect(pending).resolves.toMatchObject({ code: 'remote_runtime_unavailable' })
    expect(f.calls).toHaveLength(1)
  })

  it('releases admission and never sends close after abort during status', async () => {
    const f = await fixture('capable')
    f.holdStatus()
    const controller = new AbortController()
    const pending = f.close(3000, controller.signal).catch((error) => error)
    await f.ready()
    await f.status()
    controller.abort()
    await expect(pending).resolves.toMatchObject({ name: 'AbortError' })
    expect(f.calls).toHaveLength(1)
  })

  it('does not send close after the original deadline while status is held', async () => {
    const f = await fixture('capable')
    f.holdStatus()
    const pending = f.close().catch((error) => error)
    await f.ready()
    await f.status()
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 3001)
    f.releaseStatus()
    await expect(pending).resolves.toMatchObject({ code: 'runtime_timeout' })
    expect(f.calls).toHaveLength(1)
  })

  it('keeps the original deadline after status and keepalive frames', async () => {
    const f = await fixture('capable')
    f.holdClose()
    const pending = f.close(400).catch((error) => error)
    await f.ready()
    await vi.waitFor(() => expect(f.calls).toHaveLength(2))
    f.keepalive()
    await expect(pending).resolves.toMatchObject({ code: 'runtime_timeout' })
    expect(f.calls).toHaveLength(2)
  })

  it('also protects the legacy agent close command', async () => {
    const f = await fixture('absent', 'replacement')
    const pending = f.close(3000, undefined, 'agentSession.close')
    await f.ready()
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: 'runtime_environment_changed' }
    })
    expect(f.calls).toEqual([{ socket: 1, method: 'status.get' }])
  })
})
