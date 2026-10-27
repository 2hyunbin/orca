import { isWindowVisible } from './window-visibility-interval'

export function installWindowFocusRevalidation(
  read: (revalidating: boolean) => Promise<unknown> | void
): () => void {
  let pending = false
  let disposed = false
  const revalidate = (revalidating: boolean): void => {
    if (pending || disposed) {
      return
    }
    pending = true
    const finish = (): void => {
      pending = false
    }
    void Promise.resolve()
      .then(() => {
        if (!disposed) {
          return read(revalidating)
        }
      })
      .then(finish, finish)
  }
  const onFocus = (): void => {
    if (isWindowVisible()) {
      revalidate(true)
    }
  }
  window.addEventListener('focus', onFocus)
  document.addEventListener('visibilitychange', onFocus)
  revalidate(false)
  return () => {
    disposed = true
    window.removeEventListener('focus', onFocus)
    document.removeEventListener('visibilitychange', onFocus)
  }
}
