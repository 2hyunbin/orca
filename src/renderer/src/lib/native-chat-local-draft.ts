import type { TuiAgent } from '../../../shared/tui-agent'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { createStructuredAgentSessionId } from '../../../shared/structured-agent-session-create'
import { openStructuredAgentSessionProvisionalTab, structuredLaunchOwner } from './structured-agent-session-provisional-tab'
import { allocateNativeChatNewDraft, readNativeChatNewDraft } from '@/components/native-chat/native-chat-new-draft'
import { updateNativeChatComposerDraft } from '@/components/native-chat/native-chat-composer-draft-store'
import { requestNativeChatComposerFocus } from '@/components/native-chat/use-native-chat-composer-reveal-focus'
import type { Tab } from '../../../shared/tab-types'
import { flushSync } from 'react-dom'

/** The action owns the editor; the host owns only what its first Send submits. */
export function openNativeChatLocalDraft(args: {
  requestId: string
  worktreeId: string
  executionHostId?: ExecutionHostId
  agent: TuiAgent
  groupId?: string
  activate?: boolean
  focus?: boolean
  prompt?: string
}): Tab | null {
  const owner = structuredLaunchOwner({ route: 'structured-native-chat', executionHostId: args.executionHostId }, args.worktreeId)
  if (!owner) {
    return null
  }
  const sessionId = createStructuredAgentSessionId(args.agent, () => args.requestId)
  const tab = flushSync(() => {
  const opened = openStructuredAgentSessionProvisionalTab({ ...args, ...owner, sessionId, targetGroupId: args.groupId })
  if (!readNativeChatNewDraft(sessionId)) {
    allocateNativeChatNewDraft(sessionId, {
      owner: { workspaceId: args.worktreeId, executionHostId: owner.executionHostId },
      agent: args.agent, groupId: opened.groupId, options: {}
    })
    if (args.prompt) {
      updateNativeChatComposerDraft(`agent-session:${sessionId}`, { text: args.prompt }, 'immediate')
    }
  }
  return opened
  })
  if (args.focus !== false && args.activate !== false) {
    requestNativeChatComposerFocus(tab.id)
  }
  return tab
}
