// Keyed by `editorFileHoldKey`: one physical file. Each entry is the tail of that file's writers.
const tails = new Map<string, Promise<void>>()

/** Runs `write` after every earlier write to the same physical file has settled. */
export function withEditorFileWriteLock<T>(key: string, write: () => Promise<T>): Promise<T> {
  const result = (tails.get(key) ?? Promise.resolve()).then(write)
  const tail = result.then(
    () => undefined,
    () => undefined
  )
  tails.set(key, tail)
  void tail.then(() => {
    if (tails.get(key) === tail) {
      tails.delete(key)
    }
  })
  return result
}
