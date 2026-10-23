import { useCallback, useEffect, useState } from 'react'
import { AppState } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { deriveHostCacheKey } from './host-cache-key'
import type { MobileWebShellRuntime } from './mobile-web-shell-runtime'

/** After the page on screen painted: its route chunks share the renderer the spare boots in. */
export const SPARE_REFILL_DELAY_MS = 1000

/**
 * Boots one page for the next screen this host opens, once this one has painted and while it is the
 * screen in front of a foreground app. Skipped when the page owns the host area: its screens open
 * inside it, so a spare would rarely be shown. The native pool keeps one spare and ignores a repeat.
 */
export function useSparePageRefill(args: {
  hostId: string
  generationDirectory: string | null
  painted: boolean
  ownsHostArea: boolean
  runtime: MobileWebShellRuntime
}): void {
  const { hostId, generationDirectory, painted, ownsHostArea, runtime } = args
  const [focused, setFocused] = useState(false)
  const [active, setActive] = useState(AppState.currentState === 'active')
  useFocusEffect(
    useCallback(() => {
      setFocused(true)
      return () => setFocused(false)
    }, [])
  )
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      setActive(state === 'active')
    })
    return () => subscription.remove()
  }, [])
  const directory =
    runtime.spares !== undefined && painted && !ownsHostArea && focused && active
      ? generationDirectory
      : null
  useEffect(() => {
    if (directory === null) {
      return
    }
    const timer = setTimeout(() => {
      void runtime.spares
        ?.prepareSpare(deriveHostCacheKey(hostId), directory, runtime.mintSessionId())
        .catch(() => undefined)
    }, SPARE_REFILL_DELAY_MS)
    return () => clearTimeout(timer)
  }, [directory, hostId, runtime])
}
