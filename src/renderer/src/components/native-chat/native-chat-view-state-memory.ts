import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from 'react'
import type { Dispatch, SetStateAction } from 'react'

type Cell<T> = { current: T; listeners: Set<() => void>; retired: boolean }
export const nativeChatViewRetirements = new Set<(key: string) => void>()
export const NativeChatViewIdentity = createContext<string | null>(null)

/** A typed field owns data only; mounted readers alone own its listeners. */
export function createNativeChatReturnField<T>() {
  const records = new Map<string, Cell<T>>()
  nativeChatViewRetirements.add((key) => {
    for (const [identity, cell] of records) {
      if (identity === key || identity.startsWith(`${key}\0`)) {
        cell.retired = true
        records.delete(identity)
      }
    }
  })
  return (key: string | null, initial: () => T): Cell<T> => {
    if (key === null) {
      return { current: initial(), listeners: new Set(), retired: false }
    }
    let cell = records.get(key)
    if (!cell) {
      cell = { current: initial(), listeners: new Set(), retired: false }
      records.set(key, cell)
    }
    return cell
  }
}

export function retireNativeChatViewState(key: string): void {
  for (const retire of nativeChatViewRetirements) {
    retire(key)
  }
}

export function useNativeChatReturnRef<T>(
  field: ReturnType<typeof createNativeChatReturnField<T>>,
  initial: () => T,
  scope = ''
): Cell<T> {
  const key = useContext(NativeChatViewIdentity)
  return useMemo(
    () => field(key === null ? null : `${key}\0${scope}`, initial),
    [field, key, scope]
  )
}

export function useNativeChatReturnState<T>(
  field: ReturnType<typeof createNativeChatReturnField<T>>,
  initial: () => T
): [T, Dispatch<SetStateAction<T>>] {
  const cell = useNativeChatReturnRef(field, initial)
  const subscribe = useCallback(
    (listener: () => void) => {
      cell.listeners.add(listener)
      return () => {
        cell.listeners.delete(listener)
      }
    },
    [cell]
  )
  const value = useSyncExternalStore(subscribe, () => cell.current)
  const update = useCallback<Dispatch<SetStateAction<T>>>(
    (next) => {
      if (cell.retired) {
        return
      }
      cell.current =
        typeof next === 'function'
          ? // SAFETY: return fields hold data, never function values; the function is React's updater.
            (next as (value: T) => T)(cell.current)
          : next
      for (const listener of cell.listeners) {
        listener()
      }
    },
    [cell]
  )
  return [value, update]
}
