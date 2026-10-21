const OMP_ANSWER_RETRY_FENCE_CAPACITY = 128

export function createOmpAnswerRetryFence(): {
  blocks: (key: string) => boolean
  record: (key: string) => void
} {
  const attempts = new Set<string>()
  return {
    blocks: (key) => attempts.has(key) || attempts.size >= OMP_ANSWER_RETRY_FENCE_CAPACITY,
    record: (key) => {
      // Retain earlier attempts; reaching capacity must never reopen stale retries.
      if (attempts.size < OMP_ANSWER_RETRY_FENCE_CAPACITY) {
        attempts.add(key)
      }
    }
  }
}
