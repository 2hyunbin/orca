import type { RpcRequest } from './core'
import { classifyRuntimeLongPoll } from '../runtime-rpc/runtime-rpc-long-poll'

export function passiveJournalWait(request: RpcRequest): boolean {
  return (
    !!classifyRuntimeLongPoll(request) &&
    ![
      'agent.launch',
      'agent.launchReplay',
      'orchestration.workerStart',
      'orchestration.dispatch',
      'terminal.send'
    ].includes(request.method)
  )
}
