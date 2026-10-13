import { create } from 'zustand'
import type { PluginSyntaxFailure } from '@/lib/monaco-languages/plugin-grammar-failure'

export type PluginSyntaxModelFailure = PluginSyntaxFailure & { modelUri: string }

export const usePluginSyntaxFailureStore = create<{
  failures: Record<string, PluginSyntaxModelFailure>
}>(() => ({ failures: {} }))

export function recordPluginSyntaxFailure(
  modelUri: string,
  failure: PluginSyntaxFailure | null
): void {
  usePluginSyntaxFailureStore.setState((state) => {
    const previous = state.failures[modelUri]
    if (!failure) {
      if (!previous) {
        return state
      }
      const failures = { ...state.failures }
      delete failures[modelUri]
      return { failures }
    }
    if (
      previous?.key === failure.key &&
      previous.revision === failure.revision &&
      previous.reason === failure.reason
    ) {
      return state
    }
    return { failures: { ...state.failures, [modelUri]: { ...failure, modelUri } } }
  })
}
