import {
  nativeChatTaskListTool,
  normalizeNativeChatTaskList,
  type NativeChatTaskList,
  type NativeChatTaskListTool
} from './native-chat-task-list'
import type {
  NativeChatBlock,
  NativeChatMessage,
  NativeChatToolCallBlock
} from './native-chat-types'
import { pairToolBlocks } from './native-chat-tool-fold'

export type NativeChatTaskListPredecessors = Partial<
  Record<NativeChatTaskListTool, NativeChatToolCallBlock>
>
export type NativeChatTaskListRow = { list: NativeChatTaskList; previous?: NativeChatTaskList }

function taskListFromCall(call: NativeChatToolCallBlock): NativeChatTaskList | null {
  return call.state === 'failed' ? null : normalizeNativeChatTaskList(call.name, call.input)
}

/** Store call identities so unchanged rows stay memoized, while prepends replace their context. */
export function nativeChatTaskListPredecessors(
  messages: readonly NativeChatMessage[]
): Map<string, NativeChatTaskListPredecessors> {
  const history = new Map<string, NativeChatTaskListPredecessors>()
  let previous: NativeChatTaskListPredecessors = {}
  for (const message of messages) {
    const context = previous
    history.set(message.id, context)
    if (message.role === 'user') {
      continue
    }
    for (const { call, result } of pairToolBlocks(message.blocks)) {
      if (!call || result?.isError) {
        continue
      }
      const tool = nativeChatTaskListTool(call.name)
      if (tool && taskListFromCall(call)) {
        if (previous === context) {
          previous = { ...previous }
        }
        previous[tool] = call
      }
    }
  }
  return history
}

export function buildNativeChatTaskListRows(
  blocks: readonly NativeChatBlock[],
  predecessors: NativeChatTaskListPredecessors = {}
): {
  rows: Map<NativeChatBlock, NativeChatTaskListRow>
  consumedResults: Set<NativeChatBlock>
} {
  const rows = new Map<NativeChatBlock, NativeChatTaskListRow>()
  const consumedResults = new Set<NativeChatBlock>()
  const previous = new Map<NativeChatTaskListTool, NativeChatTaskList>()
  for (const call of Object.values(predecessors)) {
    if (!call) {
      continue
    }
    const tool = nativeChatTaskListTool(call.name)
    const list = taskListFromCall(call)
    if (tool && list) {
      previous.set(tool, list)
    }
  }
  for (const { call, result } of pairToolBlocks(blocks)) {
    if (!call || result?.isError) {
      continue
    }
    const tool = nativeChatTaskListTool(call.name)
    const list = taskListFromCall(call)
    if (!tool || !list) {
      continue
    }
    rows.set(call, { list, previous: previous.get(tool) })
    previous.set(tool, list)
    if (result) {
      consumedResults.add(result)
    }
  }
  return { rows, consumedResults }
}
