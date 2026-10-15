import { subscribeRuntimeHostContactRegained } from '@/runtime/runtime-host-contact-regained'
import { askHostCreateSupport } from '@/lib/structured-agent-session-host-admission'

type Answer = Awaited<ReturnType<typeof askHostCreateSupport>>
type Query = { generation: number; consumers: number; promise: Promise<Answer>; retire: () => void }
const inflight = new Map<string, Query>()
let generation = 0

/** Shares only live reads; a closed or timed-out menu cannot lend its answer to a reopened one. */
export function acquireMenuHostSupport(
  key: string,
  target: Parameters<typeof askHostCreateSupport>[0],
  selector: string,
  agent: Parameters<typeof askHostCreateSupport>[2],
  options: Parameters<typeof askHostCreateSupport>[3]
): { answer: Promise<Answer>; release: () => void } {
  let query = inflight.get(key)
  if (!query) {
    const id = ++generation
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let unsubscribe = (): void => {}
    let releaseAnswer = (): void => {}
    const retire = (): void => {
      if (inflight.get(key)?.generation !== id) {
        return
      }
      inflight.delete(key)
      clearTimeout(timer)
      unsubscribe()
      releaseAnswer()
      controller.abort()
    }
    const released = new Promise<Answer>((resolve) => {
      releaseAnswer = () => resolve({ kind: 'workspace-unresolved' })
    })
    const promise = Promise.race([
      released,
      askHostCreateSupport(target, selector, agent, { ...options, signal: controller.signal }),
      new Promise<Answer>((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              kind: 'unreachable',
              code: 'timeout',
              message: 'timeout',
              error: new Error('timeout')
            }),
          10_000
        )
      })
    ]).finally(retire)
    query = { generation: id, consumers: 0, promise, retire }
    inflight.set(key, query)
    if (target.kind === 'environment') {
      unsubscribe = subscribeRuntimeHostContactRegained(target.environmentId, retire)
    }
  }
  const owned = query
  owned.consumers += 1
  let released = false
  return {
    answer: owned.promise,
    release: () => {
      if (released) {
        return
      }
      released = true
      if (--owned.consumers === 0) {
        owned.retire()
      }
    }
  }
}
