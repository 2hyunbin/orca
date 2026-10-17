import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

class FakeRequest extends EventEmitter {
  readonly abort = vi.fn()
  readonly end = vi.fn()
}

const { request } = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('electron', () => ({ net: { request } }))

import { fetchRepoIconWithManualRedirects } from './electron-repo-icon-fetch'

let native: FakeRequest

beforeEach(() => {
  native = new FakeRequest()
  request.mockReset().mockReturnValue(native)
})

describe('fetchRepoIconWithManualRedirects', () => {
  it('answers a redirect with the 3xx and stops the request, without cookies', async () => {
    const pending = fetchRepoIconWithManualRedirects('https://github.com/o.png', {})
    native.emit('redirect', 302, 'GET', 'https://avatars.example/u/1', {
      location: ['https://avatars.example/u/1']
    })
    const response = await pending

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('https://avatars.example/u/1')
    expect(native.abort).toHaveBeenCalled()
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ redirect: 'manual', credentials: 'omit', method: 'GET' })
    )
  })

  it('falls back to the followed URL when the redirect has no Location', async () => {
    const pending = fetchRepoIconWithManualRedirects('https://github.com/o.png', {})
    native.emit('redirect', 301, 'GET', 'https://avatars.example/u/2', {})

    expect((await pending).headers.get('location')).toBe('https://avatars.example/u/2')
  })

  it('streams the final response body', async () => {
    const pending = fetchRepoIconWithManualRedirects('https://github.com/o.png', {})
    native.emit(
      'response',
      Object.assign(Readable.from([Buffer.from('png')]), {
        statusCode: 200,
        headers: { 'content-type': 'image/png' }
      })
    )
    const response = await pending

    expect(response.headers.get('content-type')).toBe('image/png')
    expect(await response.text()).toBe('png')
  })

  it('rejects and aborts at the caller deadline, and ends a stalled body', async () => {
    const controller = new AbortController()
    const pending = fetchRepoIconWithManualRedirects('https://github.com/o.png', {
      signal: controller.signal
    })
    const stalled = Object.assign(new Readable({ read() {} }), { statusCode: 200, headers: {} })
    native.emit('response', stalled)
    await pending
    controller.abort(new Error('deadline'))

    expect(stalled.destroyed).toBe(true)

    native = new FakeRequest()
    request.mockReturnValue(native)
    const second = new AbortController()
    const hung = fetchRepoIconWithManualRedirects('https://github.com/o.png', {
      signal: second.signal
    })
    second.abort(new Error('deadline'))
    await expect(hung).rejects.toThrow('deadline')
    expect(native.abort).toHaveBeenCalled()
  })
})
