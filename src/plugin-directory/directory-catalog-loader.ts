import {
  DIRECTORY_CATALOG_BYTE_LIMIT,
  DirectoryCatalogError,
  parseDirectoryCatalog,
  type DirectoryCatalog
} from './directory-catalog'

export type CachedDirectoryCatalog = {
  value: DirectoryCatalog
  fetchedAt: number
}

const cacheKey = (url: string): string => `orca-plugin-directory:${url}`

export function readDirectoryCache(url: string, storage: Storage): CachedDirectoryCatalog | null {
  try {
    const text = storage.getItem(cacheKey(url))
    if (!text || text.length > DIRECTORY_CATALOG_BYTE_LIMIT + 1024) {
      return null
    }
    const cached: unknown = JSON.parse(text)
    if (
      !cached ||
      typeof cached !== 'object' ||
      !('catalog' in cached) ||
      !('fetchedAt' in cached)
    ) {
      return null
    }
    const { catalog, fetchedAt } = cached
    if (typeof fetchedAt !== 'number' || !Number.isFinite(fetchedAt) || fetchedAt < 0) {
      return null
    }
    if (fetchedAt > Date.now()) {
      return null
    }
    if (typeof catalog !== 'string') {
      return null
    }
    return { value: parseDirectoryCatalog(catalog), fetchedAt }
  } catch {
    return null
  }
}

export function writeDirectoryCache(url: string, value: DirectoryCatalog, storage: Storage): void {
  try {
    const text = JSON.stringify({ catalog: JSON.stringify(value), fetchedAt: Date.now() })
    if (text.length <= DIRECTORY_CATALOG_BYTE_LIMIT + 1024) {
      storage.setItem(cacheKey(url), text)
    }
  } catch {
    // Storage quota or private browsing must not discard a fresh catalog.
  }
}

async function readCatalogResponse(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (declaredLength > DIRECTORY_CATALOG_BYTE_LIMIT) {
    throw new DirectoryCatalogError('too-large')
  }
  if (!response.body) {
    throw new DirectoryCatalogError('unavailable')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const chunks: string[] = []
  let bytes = 0
  let complete = false
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) {
        complete = true
        chunks.push(decoder.decode())
        return chunks.join('')
      }
      bytes += chunk.value.byteLength
      if (bytes > DIRECTORY_CATALOG_BYTE_LIMIT) {
        throw new DirectoryCatalogError('too-large')
      }
      chunks.push(decoder.decode(chunk.value, { stream: true }))
    }
  } finally {
    if (!complete) {
      await reader.cancel().catch(() => undefined)
    }
    reader.releaseLock()
  }
}

export async function fetchDirectoryCatalog(
  url: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  deadlineMs = 15_000
): Promise<DirectoryCatalog> {
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), deadlineMs)
  const combined = AbortSignal.any([signal, deadline.signal])
  try {
    const response = await fetcher(url, {
      signal: combined,
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-cache'
    })
    if (!response.ok) {
      throw new DirectoryCatalogError('unavailable')
    }
    const text = await readCatalogResponse(response)
    combined.throwIfAborted()
    return parseDirectoryCatalog(text)
  } catch (error) {
    if (signal.aborted) {
      throw error
    }
    if (deadline.signal.aborted) {
      throw new DirectoryCatalogError('timeout')
    }
    if (error instanceof DirectoryCatalogError) {
      throw error
    }
    throw new DirectoryCatalogError('unavailable')
  } finally {
    clearTimeout(timer)
    deadline.abort()
  }
}
