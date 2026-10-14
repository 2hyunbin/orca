// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  acquireJiraImageUrl,
  migrateLegacyJiraImages,
  hasCachedJiraImage,
  clearJiraImageCache,
  observeJiraImageHostStatus
} from './runtime-jira-image-cache'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
import { jiraImageReference } from '../../../shared/jira-attachment-image'

const { download } = vi.hoisted(() => ({ download: vi.fn() }))
vi.mock('./runtime-jira-image-client', () => ({ readRuntimeJiraImage: download }))
const target = { kind: 'environment' as const, environmentId: 'host' }
const createUrl = vi.fn()
const revoke = vi.fn()
const originalUrl = URL
beforeEach(() => {
  vi.stubGlobal(
    'URL',
    class extends originalUrl {
      static createObjectURL = createUrl
      static revokeObjectURL = revoke
    }
  )
  clearJiraImageCache()
  download.mockReset().mockResolvedValue(new Blob([Uint8Array.of(1)], { type: 'image/png' }))
  createUrl.mockReset().mockImplementation(() => `blob:${createUrl.mock.calls.length}`)
  revoke.mockReset()
  replaceRuntimeEnvironmentRevisions([{ id: 'host', createdAt: 1 }])
})
afterEach(() => {
  clearJiraImageCache()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
function acquire(reference = 'image') {
  return acquireJiraImageUrl(target, reference, new AbortController().signal)
}

describe('bounded Jira Blob image cache', () => {
  it('shares concurrent downloads, retains active URLs and revokes on clear', async () => {
    const [a, b] = await Promise.all([acquire(), acquire()])
    expect(download).toHaveBeenCalledOnce()
    expect(a.url).toBe(b.url)
    a.release()
    expect(revoke).not.toHaveBeenCalled()
    b.release()
    clearJiraImageCache()
    expect(revoke).toHaveBeenCalledWith(a.url)
  })
  it('aborts the shared transfer only after both readers cancel', async () => {
    let requestSignal: AbortSignal | undefined
    download.mockImplementation((_target, _reference, signal: AbortSignal) => {
      requestSignal = signal
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
      )
    })
    const a = new AbortController()
    const b = new AbortController()
    const first = acquireJiraImageUrl(target, 'same', a.signal).catch((error) => error)
    const second = acquireJiraImageUrl(target, 'same', b.signal).catch((error) => error)
    await vi.waitFor(() => expect(download).toHaveBeenCalledOnce())
    a.abort()
    await first
    expect(requestSignal?.aborted).toBe(false)
    b.abort()
    await second
    expect(requestSignal?.aborted).toBe(true)
  })
  it('admits no more than 24 MiB of active image URLs', async () => {
    download.mockResolvedValue(new Blob([new Uint8Array(8 * 1024 * 1024)], { type: 'image/png' }))
    const held = await Promise.all([acquire('1'), acquire('2'), acquire('3')])
    await expect(acquire('4')).rejects.toThrow('cache is full')
    expect(createUrl).toHaveBeenCalledTimes(3)
    held[0]?.release()
    const next = await acquire('4')
    expect(revoke).toHaveBeenCalledOnce()
    next.release()
    held.forEach((image) => image.release())
  })
  it('expires unused URLs and fences a same-ID host replacement', async () => {
    vi.useFakeTimers()
    const image = await acquire()
    image.release()
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(hasCachedJiraImage(target, 'image')).toBe(false)
    expect(revoke).toHaveBeenCalledWith(image.url)
    const replacement = await acquire()
    replaceRuntimeEnvironmentRevisions([{ id: 'host', createdAt: 2 }], {
      retired: ['host'],
      sameHost: []
    })
    expect(hasCachedJiraImage(target, 'image')).toBe(false)
    expect(revoke).toHaveBeenCalledWith(replacement.url)
    replacement.release()
  })
  it('clears a host cache when the connection is lost or revoked', async () => {
    const image = await acquire()
    observeJiraImageHostStatus({
      environmentId: 'host',
      pairingRevision: 1,
      sequence: 2,
      checkedAt: 0,
      status: null,
      verification: 'unavailable',
      transport: 'disconnected'
    })
    expect(hasCachedJiraImage(target, 'image')).toBe(false)
    expect(revoke).toHaveBeenCalledWith(image.url)
    image.release()
  })
  it('converts old-host image data into short references before retaining Markdown', async () => {
    const body = migrateLegacyJiraImages(
      '![shot](data:image/png;base64,AQID) and literal data:image/png;base64,AQID',
      target
    )
    expect(body).toMatch(
      /^!\[shot\]\(orca-jira-image:\/\/attachment\/[0-9a-f-]+\) and literal data:/
    )
    const url = body.match(/orca-jira-image:\/\/attachment\/[0-9a-f-]+/)?.[0]
    const reference = jiraImageReference(url)
    if (!reference) {
      throw new Error('Expected migrated image reference')
    }
    const image = await acquire(reference)
    expect(image.url).toMatch(/^blob:/)
    expect(download).not.toHaveBeenCalled()
    image.release()
    expect(migrateLegacyJiraImages('![bad](data:image/png;base64,A===)', target)).toBe('![bad]()')
  })
})
