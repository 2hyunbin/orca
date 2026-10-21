import { createContext, useContext } from 'react'

/**
 * A one-shot "already open" for the first drawer shown under it: a sheet that replaces a placeholder
 * already on screen must appear in place rather than slide in over it.
 */
export type InstantDrawerEnter = { consumed: boolean }

export const InstantDrawerEnterContext = createContext<InstantDrawerEnter | null>(null)

/** True once, for the first drawer to open under the provider. */
export function useTakeInstantDrawerEnter(): () => boolean {
  const token = useContext(InstantDrawerEnterContext)
  return () => {
    if (!token || token.consumed) {
      return false
    }
    token.consumed = true
    return true
  }
}
