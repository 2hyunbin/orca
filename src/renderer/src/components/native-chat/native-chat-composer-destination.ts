import type { NativeChatComposerHandle } from './native-chat-composer-types'

const destinations = new Map<
  HTMLElement,
  { handle: { current: NativeChatComposerHandle | null }; active: number; primary: boolean }
>()
let activation = 0

/** Registration identity survives disabled transitions; toolbar clicks retain the last focused input. */
export function registerNativeChatComposerDestination(
  root: HTMLElement,
  handle: { current: NativeChatComposerHandle | null },
  primary: boolean
): () => void {
  const entry = { handle, active: 0, primary }
  destinations.set(root, entry)
  const activate = (): void => {
    entry.active = ++activation
  }
  root.addEventListener('focusin', activate)
  root.addEventListener('pointerdown', activate)
  return () => {
    root.removeEventListener('focusin', activate)
    root.removeEventListener('pointerdown', activate)
    if (destinations.get(root) === entry) {
      destinations.delete(root)
    }
  }
}

export function nativeChatComposerDestination(
  root: HTMLElement | null,
  fallback: NativeChatComposerHandle | null
): NativeChatComposerHandle | null {
  let selected:
    | { handle: { current: NativeChatComposerHandle | null }; active: number; primary: boolean }
    | undefined
  for (const [element, entry] of destinations) {
    if (!root?.contains(element)) {
      continue
    }
    if (
      !selected ||
      entry.active > selected.active ||
      (entry.active === selected.active && entry.primary)
    ) {
      selected = entry
    }
  }
  return selected?.handle.current ?? fallback
}
