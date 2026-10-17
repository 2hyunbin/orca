import { Readable } from 'node:stream'
import { net } from 'electron'

function webBody(response: Readable): ReadableStream<Uint8Array> {
  const chunks: AsyncIterator<Uint8Array> = response[Symbol.asyncIterator]()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await chunks.next()
      if (done) {
        controller.close()
      } else {
        controller.enqueue(value)
      }
    },
    // Why destroy, not return(): return() would queue behind a pending read on a stalled body.
    cancel: () => {
      response.destroy()
    }
  })
}

/**
 * A GET that answers a redirect with the 3xx itself, as undici does with `redirect: 'manual'`.
 * Why its own request: Electron's net.fetch rejects every manual redirect, and the icon fetcher
 * must count and vet each hop.
 */
export function fetchRepoIconWithManualRedirects(
  url: string,
  init: RequestInit
): Promise<Response> {
  const { signal } = init
  return new Promise((resolve, reject) => {
    const request = net.request({ url, method: 'GET', redirect: 'manual', credentials: 'omit' })
    const onAbort = (): void => {
      request.abort()
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    request.on('redirect', (statusCode, _method, redirectUrl, responseHeaders) => {
      const headers = new Headers({ location: redirectUrl })
      for (const [key, values] of Object.entries(responseHeaders)) {
        headers.set(key, values.join(', '))
      }
      resolve(new Response(null, { headers, status: statusCode }))
      request.abort()
    })
    request.on('response', (response) => {
      if (!(response instanceof Readable)) {
        request.abort()
        reject(new TypeError('Electron response is not a readable stream'))
        return
      }
      const headers = new Headers()
      for (const [key, value] of Object.entries(response.headers)) {
        headers.set(key, Array.isArray(value) ? value.join(', ') : value)
      }
      // Why destroy on abort: a stalled body must end at the caller's deadline.
      signal?.addEventListener('abort', () => response.destroy(signal.reason), { once: true })
      resolve(new Response(webBody(response), { headers, status: response.statusCode }))
    })
    request.on('error', reject)
    request.end()
  })
}
