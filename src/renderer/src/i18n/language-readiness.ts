import { create } from 'zustand'
import {
  getBrowserLanguageDetection,
  setRendererLanguageDetection,
  type UiLanguageDetection
} from '../../../shared/ui-locale'
import { isWebClientLocation } from '../lib/web-client-location'
import { withTimeout } from '../../../shared/promise-timeout-fallback'

export const useLanguageReadiness = create<{
  ready: boolean
  error: boolean
  loading: boolean
  detection: UiLanguageDetection | null
  retryCount: number
  retryLanguageLoad: () => void
}>()((set) => ({
  ready: false,
  error: false,
  loading: false,
  detection: null,
  retryCount: 0,
  retryLanguageLoad: () =>
    set((state) => (state.loading ? state : { loading: true, retryCount: state.retryCount + 1 }))
}))

let detectionPromise: Promise<UiLanguageDetection> | undefined

export function initializeLanguageDetection(): Promise<UiLanguageDetection> {
  detectionPromise ??= (async () => {
    let detection: UiLanguageDetection | null = null
    const browserClient = isWebClientLocation()
    const browserDetection = getBrowserLanguageDetection(
      browserClient ? 'browser' : 'browser-fallback'
    )
    if (!browserClient) {
      try {
        const snapshot = window.api?.app?.getSystemLanguageDetection?.(
          browserDetection.detectedTag ? [browserDetection.detectedTag] : []
        )
        if (snapshot) {
          detection = await withTimeout<UiLanguageDetection | null>(snapshot, 1000, null)
        }
      } catch {
        // Older local bridges do not provide the optional snapshot.
      }
    }
    detection ??= browserDetection
    setRendererLanguageDetection(detection)
    useLanguageReadiness.setState({ detection })
    return detection
  })()
  return detectionPromise
}
