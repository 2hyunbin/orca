import type { vi } from 'vitest'

export type HookContext = {
  agent?: { kind: 'main' | 'sub' }
  hasUI?: boolean
  ui?: {
    setTitle?: (title: string) => void
    setEditorText?: (text: string) => void
    notify?: (message: string, level: string) => void
    onTerminalInput?: (handler: (data: string) => { consume?: boolean } | undefined) => () => void
  }
  isIdle?: () => boolean
  resolvePlanReview?: (reviewId: string, choice: string) => boolean
  model?: { provider?: unknown; id?: unknown } | null
  modelRegistry?: { getAvailable: () => { provider: string; id: string }[] }
  sessionManager?: {
    getSessionId?: () => unknown
    getSessionFile?: () => unknown
    getHeader?: () => unknown
  }
}

export type FakeCurlChild = {
  kill: ReturnType<typeof vi.fn>
  emit: (event: string, ...args: unknown[]) => boolean
  on: ReturnType<typeof vi.fn>
  stdin: {
    on: ReturnType<typeof vi.fn>
    end: ReturnType<typeof vi.fn>
  }
}

export function createCountingMap(onEntry?: () => void) {
  return class<K, V> extends Map<K, V> {
    *values(): MapIterator<V> {
      for (const value of super.values()) {
        onEntry?.()
        yield value
      }
    }
    *[Symbol.iterator](): MapIterator<[K, V]> {
      for (const entry of super[Symbol.iterator]()) {
        onEntry?.()
        yield entry
      }
    }
  }
}
