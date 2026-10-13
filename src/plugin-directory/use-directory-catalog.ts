import { useEffect, useState } from 'react'
import { DIRECTORY_CATALOG_FILENAME, type DirectoryCatalog } from './directory-catalog'
import {
  fetchDirectoryCatalog,
  readDirectoryCache,
  writeDirectoryCache
} from './directory-catalog-loader'

export type DirectoryCatalogState = {
  catalog: DirectoryCatalog | null
  loading: boolean
  cached: boolean
  error: boolean
}

export function directoryCatalogUrl(): string {
  return new URL(DIRECTORY_CATALOG_FILENAME, document.baseURI).href
}

function initialCatalog(url: string): DirectoryCatalogState {
  try {
    const cached = readDirectoryCache(url, localStorage)
    return { catalog: cached?.value ?? null, loading: true, cached: Boolean(cached), error: false }
  } catch {
    return { catalog: null, loading: true, cached: false, error: false }
  }
}

export function useDirectoryCatalog(): DirectoryCatalogState & { retry: () => void } {
  const url = directoryCatalogUrl()
  const [state, setState] = useState(() => initialCatalog(url))
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setState((current) => ({ ...current, loading: true, error: false }))
    void fetchDirectoryCatalog(url, controller.signal).then(
      (catalog) => {
        if (controller.signal.aborted) {
          return
        }
        try {
          writeDirectoryCache(url, catalog, localStorage)
        } catch {
          // Some browsers deny access to the storage object itself.
        }
        setState({ catalog, loading: false, cached: false, error: false })
      },
      () => {
        if (controller.signal.aborted) {
          return
        }
        setState((current) => ({ ...current, loading: false, error: true }))
      }
    )
    return () => controller.abort()
  }, [url, attempt])
  return { ...state, retry: () => setAttempt((value) => value + 1) }
}
