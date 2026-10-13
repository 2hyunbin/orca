import { PluginGrammarFailure, type PluginGrammarFailureReason } from './plugin-grammar-failure'

type Job = {
  owner: object
  signal: AbortSignal
  run: () => Promise<Uint32Array | null>
  resolve: (result: Uint32Array | null) => void
  cancel: () => void
  onFailure?: (reason: PluginGrammarFailureReason) => void
}

export const PLUGIN_GRAMMAR_GLOBAL_WORKER_LIMIT = 2
export const PLUGIN_GRAMMAR_GLOBAL_QUEUE_LIMIT = 8

export class PluginGrammarTaskScheduler {
  private readonly active = new Set<object>()
  private readonly queue: Job[] = []

  constructor(
    private readonly workerLimit = PLUGIN_GRAMMAR_GLOBAL_WORKER_LIMIT,
    private readonly queueLimit = PLUGIN_GRAMMAR_GLOBAL_QUEUE_LIMIT
  ) {}

  schedule(
    owner: object,
    signal: AbortSignal,
    run: () => Promise<Uint32Array | null>,
    onFailure?: (reason: PluginGrammarFailureReason) => void
  ): Promise<Uint32Array | null> {
    if (signal.aborted) {
      return Promise.resolve(null)
    }
    if (this.queue.length >= this.queueLimit) {
      onFailure?.('capacity')
      return Promise.resolve(null)
    }
    return new Promise((resolve) => {
      const job: Job = {
        owner,
        signal,
        run,
        resolve,
        onFailure,
        cancel: () => {
          const index = this.queue.indexOf(job)
          if (index !== -1) {
            this.queue.splice(index, 1)
            signal.removeEventListener('abort', job.cancel)
            resolve(null)
          }
        }
      }
      signal.addEventListener('abort', job.cancel, { once: true })
      this.queue.push(job)
      this.drain()
    })
  }

  private drain(): void {
    while (this.active.size < this.workerLimit) {
      const index = this.queue.findIndex((job) => !this.active.has(job.owner))
      if (index === -1) {
        return
      }
      const job = this.queue.splice(index, 1)[0]!
      job.signal.removeEventListener('abort', job.cancel)
      if (job.signal.aborted) {
        job.resolve(null)
        continue
      }
      this.active.add(job.owner)
      void Promise.resolve()
        .then(job.run)
        .catch((error: unknown) => {
          if (!job.signal.aborted) {
            job.onFailure?.(error instanceof PluginGrammarFailure ? error.reason : 'worker')
          }
          return null
        })
        .then((result) => {
          this.active.delete(job.owner)
          job.resolve(job.signal.aborted ? null : result)
          this.drain()
        })
    }
  }
}
