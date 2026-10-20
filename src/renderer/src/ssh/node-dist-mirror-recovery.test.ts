import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  NODE_DIST_MIRROR_SUGGESTION,
  saveNodeDistMirrorAndRetry
} from './node-dist-mirror-recovery'
import {
  beginSshConnect,
  isSshConnectInFlight,
  resetSshConnectInFlightForTests
} from './ssh-connect-in-flight'

function deps() {
  const calls: string[] = []
  let finishConnect: () => void = () => {}
  return {
    calls,
    finishConnect: () => finishConnect(),
    save: vi.fn(async (url: string) => {
      calls.push(`save ${url}`)
    }),
    connect: vi.fn((targetId: string) => {
      calls.push(`connect ${targetId}`)
      return new Promise<void>((resolve) => {
        finishConnect = resolve
      })
    })
  }
}

afterEach(() => resetSshConnectInFlightForTests())

describe('save a Node.js mirror and retry', () => {
  it('saves the normalized mirror first, then retries the connect as an in-flight attempt', async () => {
    const d = deps()
    const result = await saveNodeDistMirrorAndRetry('ssh-1', NODE_DIST_MIRROR_SUGGESTION, d)

    expect(result.outcome).toBe('retrying')
    expect(d.calls).toEqual(['save https://npmmirror.com/mirrors/node', 'connect ssh-1'])
    expect(isSshConnectInFlight('ssh-1')).toBe(true)
    d.finishConnect()
    if (result.outcome === 'retrying') {
      await result.retry
    }
    await Promise.resolve()
    expect(isSshConnectInFlight('ssh-1')).toBe(false)
  })

  it.each([
    ['', 'invalid'],
    ['   ', 'invalid'],
    ['not a url', 'invalid'],
    ['ftp://mirror.example/node', 'protocol'],
    ['https://me:secret@mirror.example/node', 'credentials'],
    ['https://mirror.example/node?token=1', 'query']
  ])('refuses %j with the setting’s validation, saving nothing', async (text, reason) => {
    const d = deps()
    await expect(saveNodeDistMirrorAndRetry('ssh-1', text, d)).resolves.toEqual({
      outcome: 'refused',
      reason
    })
    expect(d.save).not.toHaveBeenCalled()
    expect(d.connect).not.toHaveBeenCalled()
  })

  it('saves but leaves a connect already dialing to finish on its own', async () => {
    const d = deps()
    beginSshConnect('ssh-1')
    const result = await saveNodeDistMirrorAndRetry('ssh-1', 'https://mirror.example/node', d)
    expect(result.outcome).toBe('retrying')
    expect(d.save).toHaveBeenCalled()
    expect(d.connect).not.toHaveBeenCalled()
  })

  it('does not retry when the setting could not be saved', async () => {
    const d = deps()
    d.save.mockRejectedValueOnce(new Error('settings store is read-only'))
    await expect(
      saveNodeDistMirrorAndRetry('ssh-1', 'https://mirror.example/node', d)
    ).resolves.toEqual({ outcome: 'save-failed', message: 'settings store is read-only' })
    expect(d.connect).not.toHaveBeenCalled()
  })
})
