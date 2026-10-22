import type { Delivery } from './external-conversation-types'

/** Ordering per conversation: one active head, the rest behind it in arrival order. */
export class ConversationChain {
  private readonly tails = new Map<string, Promise<unknown>>()

  enqueue(id: string, run: () => Promise<Delivery>): Promise<Delivery> {
    const result = (this.tails.get(id) ?? Promise.resolve()).then(run, run)
    const tail = result.catch(() => undefined)
    this.tails.set(id, tail)
    void tail.then(() => {
      if (this.tails.get(id) === tail) {
        this.tails.delete(id)
      }
    })
    return result
  }
}
