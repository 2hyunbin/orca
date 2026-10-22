import { refused, type ConnectorRefusal, type Delivery } from './external-conversation-types'

/**
 * Ordering per conversation: one active head, the rest behind it in arrival order. A head that
 * ends its hold (agent exit, new binding) settles everything already waiting with its reason.
 */
export class ConversationChain {
  private readonly tails = new Map<string, Promise<unknown>>()
  private readonly epochs = new Map<string, number>()
  private readonly settled = new Map<string, { through: number; reason: ConnectorRefusal }>()

  enqueue(id: string, run: () => Promise<Delivery>): Promise<Delivery> {
    const epoch = this.epochs.get(id) ?? 0
    const turn = (): Promise<Delivery> => {
      const settled = this.settled.get(id)
      return settled && epoch <= settled.through ? Promise.resolve(refused(settled.reason)) : run()
    }
    const result = (this.tails.get(id) ?? Promise.resolve()).then(turn, turn)
    const tail = result.catch(() => undefined)
    this.tails.set(id, tail)
    void tail.then(() => {
      if (this.tails.get(id) === tail) {
        this.tails.delete(id)
      }
    })
    return result
  }

  settleWaiting(id: string, reason: ConnectorRefusal): void {
    const epoch = this.epochs.get(id) ?? 0
    this.settled.set(id, { through: epoch, reason })
    this.epochs.set(id, epoch + 1)
  }
}
