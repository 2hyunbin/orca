import { describe, expect, it, vi } from 'vitest'
import {
  DIRECTORY_CATALOG_BYTE_LIMIT,
  directoryCatalogSchema,
  parseDirectoryCatalog,
  browsableRepository,
  directoryListings
} from './directory-catalog'
import {
  fetchDirectoryCatalog,
  readDirectoryCache,
  writeDirectoryCache
} from './directory-catalog-loader'

const catalog = directoryCatalogSchema.parse({
  formatVersion: 1,
  source: { kind: 'git', url: 'https://example.org/catalog.git', ref: 'main' },
  catalog: {
    formatVersion: 2,
    name: 'Example catalog',
    owner: 'example',
    plugins: [
      {
        id: 'example.locale',
        name: 'Example language',
        categories: ['languages'],
        source: { kind: 'git', url: 'git@example.org:locale.git', ref: 'v1.0.0' },
        release: {
          version: '1.0.0',
          commit: 'a'.repeat(40),
          contentHash: 'b'.repeat(64),
          execution: 'data',
          minimumOrca: '1.4.214',
          license: 'MIT',
          types: ['interface-language'],
          preview: { title: 'Preview', text: '<script>this is literal text</script>' }
        }
      }
    ]
  }
})

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key)
    },
    setItem: (key, value) => {
      values.set(key, value)
    }
  }
}

describe('public directory catalog boundary', () => {
  it('shares strict pinned-release validation and preserves literal preview text', () => {
    expect(parseDirectoryCatalog(JSON.stringify(catalog))).toEqual(catalog)
    const invalid = structuredClone(catalog)
    invalid.catalog.plugins[0]!.release.commit = 'main'
    expect(() => parseDirectoryCatalog(JSON.stringify(invalid))).toThrow('invalid')
    expect(() => parseDirectoryCatalog(JSON.stringify({ ...catalog, official: true }))).toThrow(
      'invalid'
    )
    expect(() =>
      parseDirectoryCatalog(
        JSON.stringify({ ...catalog, catalog: { ...catalog.catalog, formatVersion: 1 } })
      )
    ).toThrow('invalid')
  })

  it('rejects contradictory execution metadata from fresh responses and cached catalogs', () => {
    const invalid = structuredClone(catalog)
    invalid.catalog.plugins[0]!.release.types = ['worker']
    expect(() => parseDirectoryCatalog(JSON.stringify(invalid))).toThrow('invalid')
    const storage = memoryStorage()
    storage.setItem(
      'orca-plugin-directory:http://localhost/catalog.json',
      JSON.stringify({
        catalog: JSON.stringify(invalid),
        fetchedAt: Date.now()
      })
    )
    expect(readDirectoryCache('http://localhost/catalog.json', storage)).toBeNull()
  })

  it('never turns SSH, helper protocols or credentials into browser navigation', () => {
    expect(browsableRepository('https://example.org/repository')).toBe(
      'https://example.org/repository'
    )
    for (const url of [
      'git@example.org:repository',
      'ssh://git@example.org/repository',
      'javascript:alert(1)',
      'https://user:secret@example.org/repository'
    ]) {
      expect(browsableRepository(url)).toBeNull()
    }
  })

  it('hides the same unsupported contribution categories as the app', () => {
    const input = structuredClone(catalog.catalog)
    input.plugins[0]!.categories.push('skills')
    expect(directoryListings(input)).toHaveLength(0)
  })

  it('fetches only inert metadata without credentials or redirects', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(catalog)))
    expect(
      await fetchDirectoryCatalog(
        'https://example.org/directory.json',
        new AbortController().signal,
        fetcher
      )
    ).toEqual(catalog)
    expect(fetcher).toHaveBeenCalledWith(
      'https://example.org/directory.json',
      expect.objectContaining({ credentials: 'omit', redirect: 'error', cache: 'no-cache' })
    )
  })

  it('rejects and cancels a body that exceeds the bound without a length header', async () => {
    const cancel = vi.fn()
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(DIRECTORY_CATALOG_BYTE_LIMIT + 1))
        },
        cancel
      })
    )
    await expect(
      fetchDirectoryCatalog(
        'https://example.org/index',
        new AbortController().signal,
        vi.fn().mockResolvedValue(response)
      )
    ).rejects.toMatchObject({ reason: 'too-large' })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('rejects misleading oversized headers, malformed bytes and failed responses', async () => {
    for (const response of [
      new Response('{}', {
        headers: { 'content-length': String(DIRECTORY_CATALOG_BYTE_LIMIT + 1) }
      }),
      new Response(new Uint8Array([0xff])),
      new Response('secret server error', { status: 500 }),
      new Response('{}')
    ]) {
      await expect(
        fetchDirectoryCatalog(
          'https://example.org/index',
          new AbortController().signal,
          vi.fn().mockResolvedValue(response)
        )
      ).rejects.toThrow()
    }
  })

  it('times out a stalled fetch and rejects a late result after unmount', async () => {
    const stall = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true
          })
        })
    )
    await expect(
      fetchDirectoryCatalog('https://example.org/index', new AbortController().signal, stall, 5)
    ).rejects.toMatchObject({ reason: 'timeout' })
    const controller = new AbortController()
    controller.abort()
    await expect(
      fetchDirectoryCatalog(
        'https://example.org/index',
        controller.signal,
        vi.fn().mockResolvedValue(new Response(JSON.stringify(catalog)))
      )
    ).rejects.toThrow()
  })

  it('revalidates cache bytes, scopes by deployment URL and tolerates storage denial', () => {
    const storage = memoryStorage()
    const url = 'https://example.org/plugins/index'
    writeDirectoryCache(url, catalog, storage)
    expect(readDirectoryCache(url, storage)?.value).toEqual(catalog)
    expect(readDirectoryCache('https://example.org/other/index', storage)).toBeNull()
    storage.setItem(storage.key(0)!, JSON.stringify({ catalog: '{}', fetchedAt: Date.now() }))
    expect(readDirectoryCache(url, storage)).toBeNull()
    const denied: Storage = {
      ...memoryStorage(),
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('quota')
      }
    }
    expect(readDirectoryCache(url, denied)).toBeNull()
    expect(() => writeDirectoryCache(url, catalog, denied)).not.toThrow()
  })
})
