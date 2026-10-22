import {
  captureFreshStrictProcessTableSnapshot,
  withEvidenceBudget
} from '../../shared/process-table-snapshot-reader'

export type TerminalInterfaceSnapshot = Awaited<
  ReturnType<typeof captureFreshStrictProcessTableSnapshot>
>

/** One active capture and one unstarted successor per table-owning process. */
export function createTerminalInterfaceCaptureCohort(
  capture = captureFreshStrictProcessTableSnapshot
): () => Promise<TerminalInterfaceSnapshot> {
  let running = false
  let queued: {
    promise: Promise<TerminalInterfaceSnapshot>
    resolve: (snapshot: TerminalInterfaceSnapshot) => void
    reject: (error: unknown) => void
  } | null = null
  const schedule = (): void => {
    setImmediate(() => {
      if (running || !queued) {
        return
      }
      const cohort = queued
      queued = null
      running = true
      void Promise.resolve()
        .then(capture)
        .then(cohort.resolve, cohort.reject)
        .finally(() => {
          running = false
          if (queued) {
            schedule()
          }
        })
    })
  }
  return () => {
    if (!queued) {
      queued = Promise.withResolvers<TerminalInterfaceSnapshot>()
      if (!running) {
        schedule()
      }
    }
    return withEvidenceBudget(queued.promise)
  }
}

export const requestTerminalInterfaceSnapshot = createTerminalInterfaceCaptureCohort()
